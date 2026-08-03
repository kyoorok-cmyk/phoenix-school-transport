/**
 * Edge Function: manage-schedules
 *
 * Manages transport schedules and trip generation for school transport operators.
 *
 * Actions (via request body { action: '...' }):
 *   - list: List schedules for tenant (with route, vehicle, driver info)
 *   - create: Create a new schedule with validation
 *   - update: Update schedule details
 *   - deactivate: Soft-delete schedule (set is_active=false)
 *   - generate_trips: Generate trip instances 7 days in advance
 *   - cancel_trip: Cancel a specific trip and notify guardians
 *
 * Auth: Requires `operator` or `admin` role.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateRequired, validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

interface CallerInfo {
  id: string;
  tenant_id: string;
  role: string;
  email: string;
}

type TripType = "morning_pickup" | "afternoon_dropoff";
type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const VALID_TRIP_TYPES: TripType[] = ["morning_pickup", "afternoon_dropoff"];
const VALID_WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ALLOWED_CALLER_ROLES = ["operator", "admin"] as const;
const TRIP_GENERATION_DAYS_AHEAD = 7;

// ─── Helper: Map JS day index (0=Sun) to weekday abbreviation ─────────────────

function getDayAbbr(dayIndex: number): Weekday {
  const map: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[dayIndex];
}

// ─── Helper: Format date as YYYY-MM-DD ────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── Helper: Verify caller has operator or admin role ──────────────────────────

async function verifyCallerRole(req: Request): Promise<CallerInfo> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Response(
      JSON.stringify({
        error: "Missing or invalid authorization header",
        code: "AUTH_MISSING",
      } as ErrorResponse),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Response(
      JSON.stringify({
        error: "Invalid or expired token",
        code: "AUTH_INVALID",
      } as ErrorResponse),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const role = user.user_metadata?.role;
  const tenantId = user.user_metadata?.tenant_id;

  if (!ALLOWED_CALLER_ROLES.includes(role as typeof ALLOWED_CALLER_ROLES[number])) {
    throw new Response(
      JSON.stringify({
        error: "Forbidden: operator or admin role required",
        code: "AUTH_FORBIDDEN",
      } as ErrorResponse),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  return { id: user.id, tenant_id: tenantId, role, email: user.email || "" };
}

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient(): ReturnType<typeof createClient> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Helper: Log to transport_audit_log ────────────────────────────────────────

async function logAuditEvent(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    user_id: string;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    details: Record<string, unknown>;
    ip_address: string;
  }
): Promise<void> {
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+$/;
  const safeIp = ipRegex.test(params.ip_address) ? params.ip_address : "0.0.0.0";

  const { error } = await adminClient.from("transport_audit_log").insert({
    tenant_id: params.tenant_id,
    user_id: params.user_id,
    event_type: params.event_type,
    entity_type: params.entity_type,
    entity_id: params.entity_id,
    details: params.details,
    ip_address: safeIp,
  });

  if (error) {
    console.error("[manage-schedules][audit] Failed to log:", error.message);
  }
}

// ─── Action: list ──────────────────────────────────────────────────────────────

async function handleList(
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const adminClient = getAdminClient();

  const { data, error } = await adminClient
    .from("transport_schedules")
    .select(`
      *,
      route:transport_routes(id, route_name, school_name),
      vehicle:transport_vehicles(id, registration_number, make, model),
      driver:users(id, raw_user_meta_data)
    `)
    .eq("tenant_id", caller.tenant_id)
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch schedules", code: "FETCH_ERROR", details: error.message } as ErrorResponse),
      { status: 500, headers }
    );
  }

  return new Response(JSON.stringify({ schedules: data }), { status: 200, headers });
}

// ─── Action: create ────────────────────────────────────────────────────────────

async function handleCreate(
  body: Record<string, unknown>,
  caller: CallerInfo,
  ip: string,
  headers: Record<string, string>
): Promise<Response> {
  const { missing } = validateRequired(
    {
      route_id: body.route_id,
      vehicle_id: body.vehicle_id,
      driver_id: body.driver_id,
      trip_type: body.trip_type,
      departure_time: body.departure_time,
      active_days: body.active_days,
    },
    ["route_id", "vehicle_id", "driver_id", "trip_type", "departure_time", "active_days"]
  );

  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: "Validation failed", code: "VALIDATION_ERROR", details: missing.map((f) => `${f} is required`) } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate UUIDs
  for (const field of ["route_id", "vehicle_id", "driver_id"]) {
    if (!validateUUID(body[field] as string)) {
      return new Response(
        JSON.stringify({ error: `Invalid ${field} format`, code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Validate trip_type
  if (!VALID_TRIP_TYPES.includes(body.trip_type as TripType)) {
    return new Response(
      JSON.stringify({ error: "Invalid trip_type", code: "VALIDATION_ERROR", details: `Must be one of: ${VALID_TRIP_TYPES.join(", ")}` } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate departure_time format (HH:MM)
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timeRegex.test(body.departure_time as string)) {
    return new Response(
      JSON.stringify({ error: "Invalid departure_time format", code: "VALIDATION_ERROR", details: "Must be HH:MM (24-hour)" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate active_days
  const activeDays = body.active_days as string[];
  if (!Array.isArray(activeDays) || activeDays.length === 0) {
    return new Response(
      JSON.stringify({ error: "active_days must be a non-empty array", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }
  for (const day of activeDays) {
    if (!VALID_WEEKDAYS.includes(day as Weekday)) {
      return new Response(
        JSON.stringify({ error: `Invalid weekday: ${day}`, code: "VALIDATION_ERROR", details: `Must be one of: ${VALID_WEEKDAYS.join(", ")}` } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  const adminClient = getAdminClient();

  // Validate vehicle belongs to tenant and compliance is not expired
  const { data: vehicle, error: vehicleError } = await adminClient
    .from("transport_vehicles")
    .select("id, compliance_certificate_expiry, tenant_id")
    .eq("id", body.vehicle_id as string)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (vehicleError || !vehicle) {
    return new Response(
      JSON.stringify({ error: "Vehicle not found or does not belong to tenant", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  const today = new Date();
  const expiryDate = new Date(vehicle.compliance_certificate_expiry);
  if (expiryDate < today) {
    return new Response(
      JSON.stringify({ error: "Vehicle compliance certificate has expired", code: "COMPLIANCE_EXPIRED", details: `Expiry: ${vehicle.compliance_certificate_expiry}` } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate driver exists and belongs to same tenant
  const { data: driverData, error: driverError } = await adminClient.auth.admin.getUserById(body.driver_id as string);

  if (driverError || !driverData?.user) {
    return new Response(
      JSON.stringify({ error: "Driver not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  const driverTenantId = driverData.user.user_metadata?.tenant_id;
  if (driverTenantId !== caller.tenant_id) {
    return new Response(
      JSON.stringify({ error: "Driver does not belong to this tenant", code: "AUTH_FORBIDDEN" } as ErrorResponse),
      { status: 403, headers }
    );
  }

  // Validate route belongs to tenant
  const { data: route, error: routeError } = await adminClient
    .from("transport_routes")
    .select("id")
    .eq("id", body.route_id as string)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (routeError || !route) {
    return new Response(
      JSON.stringify({ error: "Route not found or does not belong to tenant", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Insert schedule
  const { data: schedule, error: insertError } = await adminClient
    .from("transport_schedules")
    .insert({
      tenant_id: caller.tenant_id,
      route_id: body.route_id as string,
      vehicle_id: body.vehicle_id as string,
      driver_id: body.driver_id as string,
      trip_type: body.trip_type as string,
      departure_time: body.departure_time as string,
      active_days: activeDays,
      is_active: true,
    })
    .select()
    .single();

  if (insertError) {
    return new Response(
      JSON.stringify({ error: "Failed to create schedule", code: "CREATE_FAILED", details: insertError.message } as ErrorResponse),
      { status: 500, headers }
    );
  }

  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "schedule_created",
    entity_type: "schedule",
    entity_id: schedule.id,
    details: { route_id: body.route_id, vehicle_id: body.vehicle_id, driver_id: body.driver_id, trip_type: body.trip_type },
    ip_address: ip,
  });

  return new Response(JSON.stringify({ message: "Schedule created", schedule }), { status: 201, headers });
}

// ─── Action: update ────────────────────────────────────────────────────────────

async function handleUpdate(
  body: Record<string, unknown>,
  caller: CallerInfo,
  ip: string,
  headers: Record<string, string>
): Promise<Response> {
  const scheduleId = body.schedule_id as string;

  if (!scheduleId || !validateUUID(scheduleId)) {
    return new Response(
      JSON.stringify({ error: "Valid schedule_id is required", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Verify schedule exists and belongs to tenant
  const { data: existing, error: fetchError } = await adminClient
    .from("transport_schedules")
    .select("*")
    .eq("id", scheduleId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchError || !existing) {
    return new Response(
      JSON.stringify({ error: "Schedule not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Build update object from allowed fields
  const updateFields: Record<string, unknown> = {};

  if (body.route_id !== undefined) {
    if (!validateUUID(body.route_id as string)) {
      return new Response(
        JSON.stringify({ error: "Invalid route_id format", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    const { data: route } = await adminClient
      .from("transport_routes")
      .select("id")
      .eq("id", body.route_id as string)
      .eq("tenant_id", caller.tenant_id)
      .single();
    if (!route) {
      return new Response(
        JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
        { status: 404, headers }
      );
    }
    updateFields.route_id = body.route_id;
  }

  if (body.vehicle_id !== undefined) {
    if (!validateUUID(body.vehicle_id as string)) {
      return new Response(
        JSON.stringify({ error: "Invalid vehicle_id format", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    const { data: vehicle } = await adminClient
      .from("transport_vehicles")
      .select("id, compliance_certificate_expiry")
      .eq("id", body.vehicle_id as string)
      .eq("tenant_id", caller.tenant_id)
      .single();
    if (!vehicle) {
      return new Response(
        JSON.stringify({ error: "Vehicle not found", code: "NOT_FOUND" } as ErrorResponse),
        { status: 404, headers }
      );
    }
    if (new Date(vehicle.compliance_certificate_expiry) < new Date()) {
      return new Response(
        JSON.stringify({ error: "Vehicle compliance certificate has expired", code: "COMPLIANCE_EXPIRED" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.vehicle_id = body.vehicle_id;
  }

  if (body.driver_id !== undefined) {
    if (!validateUUID(body.driver_id as string)) {
      return new Response(
        JSON.stringify({ error: "Invalid driver_id format", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    const { data: driverData } = await adminClient.auth.admin.getUserById(body.driver_id as string);
    if (!driverData?.user || driverData.user.user_metadata?.tenant_id !== caller.tenant_id) {
      return new Response(
        JSON.stringify({ error: "Driver not found or does not belong to tenant", code: "NOT_FOUND" } as ErrorResponse),
        { status: 404, headers }
      );
    }
    updateFields.driver_id = body.driver_id;
  }

  if (body.trip_type !== undefined) {
    if (!VALID_TRIP_TYPES.includes(body.trip_type as TripType)) {
      return new Response(
        JSON.stringify({ error: "Invalid trip_type", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.trip_type = body.trip_type;
  }

  if (body.departure_time !== undefined) {
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRegex.test(body.departure_time as string)) {
      return new Response(
        JSON.stringify({ error: "Invalid departure_time format (HH:MM)", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.departure_time = body.departure_time;
  }

  if (body.active_days !== undefined) {
    const days = body.active_days as string[];
    if (!Array.isArray(days) || days.length === 0) {
      return new Response(
        JSON.stringify({ error: "active_days must be a non-empty array", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }
    for (const day of days) {
      if (!VALID_WEEKDAYS.includes(day as Weekday)) {
        return new Response(
          JSON.stringify({ error: `Invalid weekday: ${day}`, code: "VALIDATION_ERROR" } as ErrorResponse),
          { status: 400, headers }
        );
      }
    }
    updateFields.active_days = days;
  }

  if (Object.keys(updateFields).length === 0) {
    return new Response(
      JSON.stringify({ error: "No valid fields to update", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  updateFields.updated_at = new Date().toISOString();

  const { data: updated, error: updateError } = await adminClient
    .from("transport_schedules")
    .update(updateFields)
    .eq("id", scheduleId)
    .eq("tenant_id", caller.tenant_id)
    .select()
    .single();

  if (updateError) {
    return new Response(
      JSON.stringify({ error: "Failed to update schedule", code: "UPDATE_FAILED", details: updateError.message } as ErrorResponse),
      { status: 500, headers }
    );
  }

  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "schedule_updated",
    entity_type: "schedule",
    entity_id: scheduleId,
    details: { updated_fields: Object.keys(updateFields) },
    ip_address: ip,
  });

  return new Response(JSON.stringify({ message: "Schedule updated", schedule: updated }), { status: 200, headers });
}

// ─── Action: deactivate ────────────────────────────────────────────────────────

async function handleDeactivate(
  body: Record<string, unknown>,
  caller: CallerInfo,
  ip: string,
  headers: Record<string, string>
): Promise<Response> {
  const scheduleId = body.schedule_id as string;

  if (!scheduleId || !validateUUID(scheduleId)) {
    return new Response(
      JSON.stringify({ error: "Valid schedule_id is required", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  const { data: updated, error: updateError } = await adminClient
    .from("transport_schedules")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", scheduleId)
    .eq("tenant_id", caller.tenant_id)
    .select()
    .single();

  if (updateError || !updated) {
    return new Response(
      JSON.stringify({ error: "Schedule not found or deactivation failed", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "schedule_deactivated",
    entity_type: "schedule",
    entity_id: scheduleId,
    details: {},
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Schedule deactivated", schedule: updated }),
    { status: 200, headers }
  );
}

// ─── Action: generate_trips ────────────────────────────────────────────────────

async function handleGenerateTrips(
  caller: CallerInfo,
  ip: string,
  headers: Record<string, string>
): Promise<Response> {
  const adminClient = getAdminClient();

  // Fetch all active schedules for this tenant
  const { data: schedules, error: schedError } = await adminClient
    .from("transport_schedules")
    .select("*")
    .eq("tenant_id", caller.tenant_id)
    .eq("is_active", true);

  if (schedError) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch schedules", code: "FETCH_ERROR", details: schedError.message } as ErrorResponse),
      { status: 500, headers }
    );
  }

  if (!schedules || schedules.length === 0) {
    return new Response(
      JSON.stringify({ message: "No active schedules found", trips_created: 0 }),
      { status: 200, headers }
    );
  }

  // Fetch school closures for the date range
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + TRIP_GENERATION_DAYS_AHEAD);

  const { data: closures } = await adminClient
    .from("transport_school_closures")
    .select("closure_date")
    .eq("tenant_id", caller.tenant_id)
    .gte("closure_date", formatDate(today))
    .lte("closure_date", formatDate(endDate));

  const closureDates = new Set(
    (closures || []).map((c: { closure_date: string }) => c.closure_date)
  );

  // Generate trip records for each schedule
  const tripsToInsert: Array<{
    tenant_id: string;
    schedule_id: string;
    route_id: string;
    vehicle_id: string;
    driver_id: string;
    trip_date: string;
    trip_type: string;
    scheduled_departure: string;
    status: string;
  }> = [];

  for (const schedule of schedules) {
    const activeDays: string[] = schedule.active_days || [];

    // Iterate each date from today to today + 7 days
    for (let d = 0; d <= TRIP_GENERATION_DAYS_AHEAD; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() + d);
      const dateStr = formatDate(date);
      const dayAbbr = getDayAbbr(date.getDay());

      // Skip if day not in active_days
      if (!activeDays.includes(dayAbbr)) continue;

      // Skip if date is a school closure
      if (closureDates.has(dateStr)) continue;

      tripsToInsert.push({
        tenant_id: caller.tenant_id,
        schedule_id: schedule.id,
        route_id: schedule.route_id,
        vehicle_id: schedule.vehicle_id,
        driver_id: schedule.driver_id,
        trip_date: dateStr,
        trip_type: schedule.trip_type,
        scheduled_departure: schedule.departure_time,
        status: "scheduled",
      });
    }
  }

  if (tripsToInsert.length === 0) {
    return new Response(
      JSON.stringify({ message: "No trips to generate for the upcoming period", trips_created: 0 }),
      { status: 200, headers }
    );
  }

  // Insert trips, using onConflict to skip duplicates (UNIQUE: schedule_id + trip_date)
  const { data: insertedTrips, error: insertError } = await adminClient
    .from("transport_trips")
    .upsert(tripsToInsert, { onConflict: "schedule_id,trip_date", ignoreDuplicates: true })
    .select();

  if (insertError) {
    return new Response(
      JSON.stringify({ error: "Failed to generate trips", code: "INSERT_ERROR", details: insertError.message } as ErrorResponse),
      { status: 500, headers }
    );
  }

  const tripsCreated = insertedTrips?.length || 0;

  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "trips_generated",
    entity_type: "trip",
    entity_id: null,
    details: { trips_created: tripsCreated, date_range: { from: formatDate(today), to: formatDate(endDate) } },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Trips generated successfully", trips_created: tripsCreated }),
    { status: 200, headers }
  );
}

// ─── Action: cancel_trip ───────────────────────────────────────────────────────

async function handleCancelTrip(
  body: Record<string, unknown>,
  caller: CallerInfo,
  ip: string,
  headers: Record<string, string>
): Promise<Response> {
  const tripId = body.trip_id as string;
  const cancellationReason = body.cancellation_reason as string;

  if (!tripId || !validateUUID(tripId)) {
    return new Response(
      JSON.stringify({ error: "Valid trip_id is required", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  if (!cancellationReason || typeof cancellationReason !== "string" || cancellationReason.trim() === "") {
    return new Response(
      JSON.stringify({ error: "cancellation_reason is required", code: "VALIDATION_ERROR" } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Update trip status to cancelled
  const { data: trip, error: updateError } = await adminClient
    .from("transport_trips")
    .update({
      status: "cancelled",
      cancellation_reason: cancellationReason.trim(),
    })
    .eq("id", tripId)
    .eq("tenant_id", caller.tenant_id)
    .eq("status", "scheduled")
    .select("*, route:transport_routes(id, route_name)")
    .single();

  if (updateError || !trip) {
    return new Response(
      JSON.stringify({ error: "Trip not found or cannot be cancelled (must be scheduled)", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Find all students assigned to this route to notify their guardians
  const { data: students } = await adminClient
    .from("transport_students")
    .select("id")
    .eq("assigned_route_id", trip.route_id)
    .eq("tenant_id", caller.tenant_id)
    .eq("status", "active");

  const studentIds = (students || []).map((s: { id: string }) => s.id);

  // Find guardians for these students
  let guardiansToNotify: Array<{ guardian_id: string }> = [];
  if (studentIds.length > 0) {
    const { data: guardianLinks } = await adminClient
      .from("transport_student_guardians")
      .select("guardian_id")
      .in("student_id", studentIds);

    // Deduplicate guardian IDs
    const uniqueGuardianIds = [...new Set((guardianLinks || []).map((g: { guardian_id: string }) => g.guardian_id))];
    guardiansToNotify = uniqueGuardianIds.map((id) => ({ guardian_id: id }));
  }

  // Queue notifications to all affected guardians using their preferred channel
  if (guardiansToNotify.length > 0) {
    // Fetch guardian preferred channels
    const guardianIds = guardiansToNotify.map((g) => g.guardian_id);
    const { data: guardianPrefs } = await adminClient
      .from("transport_guardians")
      .select("id, preferred_notification_channel")
      .in("id", guardianIds);

    const prefMap = new Map(
      (guardianPrefs || []).map((g: { id: string; preferred_notification_channel: string }) => [g.id, g.preferred_notification_channel])
    );

    const notifications = guardiansToNotify.map((g) => ({
      tenant_id: caller.tenant_id,
      guardian_id: g.guardian_id,
      notification_type: "trip_cancelled",
      channel: prefMap.get(g.guardian_id) || "sms",
      template_name: "trip_cancelled",
      template_params: {
        route_name: trip.route?.route_name || "Unknown",
        trip_date: trip.trip_date,
        trip_type: trip.trip_type,
        reason: cancellationReason.trim(),
      },
      delivery_status: "pending",
    }));

    const { error: notifError } = await adminClient
      .from("transport_notifications")
      .insert(notifications);

    if (notifError) {
      console.error("[manage-schedules] Failed to queue notifications:", notifError.message);
    }
  }

  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "trip_cancelled",
    entity_type: "trip",
    entity_id: tripId,
    details: {
      route_id: trip.route_id,
      trip_date: trip.trip_date,
      cancellation_reason: cancellationReason.trim(),
      guardians_notified: guardiansToNotify.length,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Trip cancelled and guardians notified",
      trip_id: tripId,
      guardians_notified: guardiansToNotify.length,
    }),
    { status: 200, headers }
  );
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  try {
    // Only POST is supported (action-based routing)
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Use POST with action field.", code: "METHOD_NOT_ALLOWED" } as ErrorResponse),
        { status: 405, headers }
      );
    }

    // Verify caller has operator or admin role
    const caller = await verifyCallerRole(req);
    const ip = extractIp(req);

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", code: "INVALID_REQUEST" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const action = body.action as string;

    if (!action) {
      return new Response(
        JSON.stringify({ error: "action field is required", code: "VALIDATION_ERROR", details: "Valid actions: list, create, update, deactivate, generate_trips, cancel_trip" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    switch (action) {
      case "list":
        return await handleList(caller, headers);
      case "create":
        return await handleCreate(body, caller, ip, headers);
      case "update":
        return await handleUpdate(body, caller, ip, headers);
      case "deactivate":
        return await handleDeactivate(body, caller, ip, headers);
      case "generate_trips":
        return await handleGenerateTrips(caller, ip, headers);
      case "cancel_trip":
        return await handleCancelTrip(body, caller, ip, headers);
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}`, code: "INVALID_ACTION", details: "Valid actions: list, create, update, deactivate, generate_trips, cancel_trip" } as ErrorResponse),
          { status: 400, headers }
        );
    }
  } catch (error) {
    // If verifyCallerRole threw a Response, return it with CORS headers
    if (error instanceof Response) {
      const body = await error.text();
      return new Response(body, {
        status: error.status,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message, code: "INTERNAL_ERROR" } as ErrorResponse),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
