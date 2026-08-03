/**
 * Edge Function: record-attendance
 *
 * Records student attendance at stops during active trips.
 *
 * Auth: Requires `driver`, `operator`, or `admin` role.
 * Body: { trip_id, student_id, stop_id, status: 'boarded'|'absent'|'dropped_off', latitude?, longitude? }
 *
 * Logic:
 * 1. Validate trip exists, is in_progress, and belongs to caller's tenant
 * 2. Validate student exists and is assigned to the trip's route
 * 3. Validate stop belongs to the trip's route
 * 4. Insert attendance record in transport_attendance
 * 5. Queue notification to student's guardians based on status
 * 6. Log to audit log
 *
 * Requirements: 6.4, 6.5, 8.2, 8.3
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateRequired, validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecordAttendanceRequest {
  trip_id: string;
  student_id: string;
  stop_id: string;
  status: "boarded" | "absent" | "dropped_off";
  latitude?: number;
  longitude?: number;
}

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

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_CALLER_ROLES = ["driver", "operator", "admin"] as const;
const VALID_STATUSES = ["boarded", "absent", "dropped_off"] as const;

// ─── Helper: Verify caller has driver, operator, or admin role ────────────────

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
        error: "Forbidden: driver, operator, or admin role required",
        code: "AUTH_FORBIDDEN",
        details: { required_roles: [...ALLOWED_CALLER_ROLES], current_role: role || "unknown" },
      } as ErrorResponse),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  return {
    id: user.id,
    tenant_id: tenantId,
    role,
    email: user.email || "",
  };
}

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient(): ReturnType<typeof createClient> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// ─── Helper: Log attendance event to transport_audit_log ───────────────────────

async function logAttendanceEvent(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    user_id: string;
    event_type: string;
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
    entity_type: "attendance",
    entity_id: params.entity_id,
    details: params.details,
    ip_address: safeIp,
  });

  if (error) {
    console.error("[record-attendance][audit] Failed to log event:", error.message, params);
  }
}

// ─── Helper: Queue guardian notifications for attendance event ──────────────────

async function queueGuardianNotifications(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    student_id: string;
    notification_type: "boarded" | "absent" | "dropped_off";
    student_name: string;
    route_name: string;
    stop_name: string;
  }
): Promise<void> {
  // Fetch all guardians linked to this student
  const { data: guardianLinks, error: guardianError } = await adminClient
    .from("transport_student_guardians")
    .select("guardian_id")
    .eq("student_id", params.student_id);

  if (guardianError || !guardianLinks || guardianLinks.length === 0) {
    console.warn(
      "[record-attendance][notify] No guardians found for student:",
      params.student_id,
      guardianError?.message
    );
    return;
  }

  const guardianIds = guardianLinks.map((link) => link.guardian_id);

  // Fetch guardian details for preferred channel
  const { data: guardians, error: fetchError } = await adminClient
    .from("transport_guardians")
    .select("id, preferred_notification_channel")
    .in("id", guardianIds);

  if (fetchError || !guardians || guardians.length === 0) {
    console.warn(
      "[record-attendance][notify] Failed to fetch guardian details:",
      fetchError?.message
    );
    return;
  }

  // Insert notification records for each guardian
  const notificationRecords = guardians.map((guardian) => ({
    tenant_id: params.tenant_id,
    guardian_id: guardian.id,
    notification_type: params.notification_type,
    channel: guardian.preferred_notification_channel || "sms",
    template_name: `student_${params.notification_type}`,
    template_params: {
      student_name: params.student_name,
      route_name: params.route_name,
      stop_name: params.stop_name,
    },
    delivery_status: "pending",
  }));

  const { error: insertError } = await adminClient
    .from("transport_notifications")
    .insert(notificationRecords);

  if (insertError) {
    console.error(
      "[record-attendance][notify] Failed to queue notifications:",
      insertError.message
    );
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  try {
    // Only POST is supported
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Method not allowed",
          code: "METHOD_NOT_ALLOWED",
        } as ErrorResponse),
        { status: 405, headers }
      );
    }

    // Verify caller has driver, operator, or admin role
    const caller = await verifyCallerRole(req);
    const ip = extractIp(req);

    // Parse request body
    let body: RecordAttendanceRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: "Invalid JSON body",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate required fields
    const { valid, missing } = validateRequired(
      {
        trip_id: body.trip_id,
        student_id: body.student_id,
        stop_id: body.stop_id,
        status: body.status,
      },
      ["trip_id", "student_id", "stop_id", "status"]
    );

    if (!valid) {
      return new Response(
        JSON.stringify({
          error: "Validation failed: missing required fields",
          code: "VALIDATION_ERROR",
          details: missing.map((f) => `${f} is required`),
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate UUIDs
    if (!validateUUID(body.trip_id)) {
      return new Response(
        JSON.stringify({
          error: "trip_id must be a valid UUID",
          code: "VALIDATION_ERROR",
          details: { field: "trip_id" },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    if (!validateUUID(body.student_id)) {
      return new Response(
        JSON.stringify({
          error: "student_id must be a valid UUID",
          code: "VALIDATION_ERROR",
          details: { field: "student_id" },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    if (!validateUUID(body.stop_id)) {
      return new Response(
        JSON.stringify({
          error: "stop_id must be a valid UUID",
          code: "VALIDATION_ERROR",
          details: { field: "stop_id" },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate status
    if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
      return new Response(
        JSON.stringify({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "VALIDATION_ERROR",
          details: { field: "status", valid_values: [...VALID_STATUSES], received: body.status },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate optional GPS coordinates
    if (body.latitude !== undefined && body.latitude !== null) {
      if (typeof body.latitude !== "number" || body.latitude < -90 || body.latitude > 90) {
        return new Response(
          JSON.stringify({
            error: "latitude must be a number between -90 and 90",
            code: "VALIDATION_ERROR",
            details: { field: "latitude", received: body.latitude },
          } as ErrorResponse),
          { status: 400, headers }
        );
      }
    }

    if (body.longitude !== undefined && body.longitude !== null) {
      if (typeof body.longitude !== "number" || body.longitude < -180 || body.longitude > 180) {
        return new Response(
          JSON.stringify({
            error: "longitude must be a number between -180 and 180",
            code: "VALIDATION_ERROR",
            details: { field: "longitude", received: body.longitude },
          } as ErrorResponse),
          { status: 400, headers }
        );
      }
    }

    const adminClient = getAdminClient();

    // ─── Step 1: Validate trip exists, is in_progress, belongs to caller's tenant ──

    const { data: trip, error: tripError } = await adminClient
      .from("transport_trips")
      .select("id, tenant_id, route_id, status, driver_id")
      .eq("id", body.trip_id)
      .eq("tenant_id", caller.tenant_id)
      .maybeSingle();

    if (tripError) {
      return new Response(
        JSON.stringify({
          error: "Failed to fetch trip",
          code: "INTERNAL_ERROR",
          details: tripError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    if (!trip) {
      return new Response(
        JSON.stringify({
          error: "Trip not found or does not belong to your tenant",
          code: "NOT_FOUND",
          details: { trip_id: body.trip_id },
        } as ErrorResponse),
        { status: 404, headers }
      );
    }

    if (trip.status !== "in_progress") {
      return new Response(
        JSON.stringify({
          error: "Attendance can only be recorded for trips that are in progress",
          code: "TRIP_NOT_IN_PROGRESS",
          details: { trip_id: body.trip_id, current_status: trip.status },
        } as ErrorResponse),
        { status: 409, headers }
      );
    }

    // If caller is a driver, verify they are assigned to this trip
    if (caller.role === "driver" && trip.driver_id !== caller.id) {
      return new Response(
        JSON.stringify({
          error: "You are not assigned to this trip",
          code: "AUTH_FORBIDDEN",
          details: { trip_id: body.trip_id },
        } as ErrorResponse),
        { status: 403, headers }
      );
    }

    // ─── Step 2: Validate student exists and is assigned to the trip's route ───────

    const { data: student, error: studentError } = await adminClient
      .from("transport_students")
      .select("id, full_name, assigned_route_id, status")
      .eq("id", body.student_id)
      .eq("tenant_id", caller.tenant_id)
      .maybeSingle();

    if (studentError) {
      return new Response(
        JSON.stringify({
          error: "Failed to fetch student",
          code: "INTERNAL_ERROR",
          details: studentError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    if (!student) {
      return new Response(
        JSON.stringify({
          error: "Student not found or does not belong to your tenant",
          code: "NOT_FOUND",
          details: { student_id: body.student_id },
        } as ErrorResponse),
        { status: 404, headers }
      );
    }

    if (student.assigned_route_id !== trip.route_id) {
      return new Response(
        JSON.stringify({
          error: "Student is not assigned to this trip's route",
          code: "VALIDATION_ERROR",
          details: {
            student_id: body.student_id,
            student_route_id: student.assigned_route_id,
            trip_route_id: trip.route_id,
          },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // ─── Step 3: Validate stop belongs to the trip's route ─────────────────────────

    const { data: stop, error: stopError } = await adminClient
      .from("transport_stops")
      .select("id, stop_name, route_id")
      .eq("id", body.stop_id)
      .eq("route_id", trip.route_id)
      .maybeSingle();

    if (stopError) {
      return new Response(
        JSON.stringify({
          error: "Failed to fetch stop",
          code: "INTERNAL_ERROR",
          details: stopError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    if (!stop) {
      return new Response(
        JSON.stringify({
          error: "Stop not found or does not belong to this trip's route",
          code: "VALIDATION_ERROR",
          details: { stop_id: body.stop_id, trip_route_id: trip.route_id },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // ─── Step 4: Insert attendance record ──────────────────────────────────────────

    const attendanceRecord = {
      tenant_id: caller.tenant_id,
      trip_id: body.trip_id,
      student_id: body.student_id,
      stop_id: body.stop_id,
      status: body.status,
      recorded_at: new Date().toISOString(),
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      synced_from_offline: false,
    };

    const { data: attendance, error: insertError } = await adminClient
      .from("transport_attendance")
      .insert(attendanceRecord)
      .select()
      .single();

    if (insertError) {
      // Handle unique constraint violation (duplicate attendance for same trip/student/status)
      if (insertError.code === "23505") {
        return new Response(
          JSON.stringify({
            error: "Attendance already recorded for this student on this trip with this status",
            code: "DUPLICATE_ATTENDANCE",
            details: {
              trip_id: body.trip_id,
              student_id: body.student_id,
              status: body.status,
            },
          } as ErrorResponse),
          { status: 409, headers }
        );
      }

      return new Response(
        JSON.stringify({
          error: "Failed to record attendance",
          code: "INTERNAL_ERROR",
          details: insertError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // ─── Step 5: Queue guardian notifications ──────────────────────────────────────

    // Fetch route name for notification template params
    const { data: route } = await adminClient
      .from("transport_routes")
      .select("route_name")
      .eq("id", trip.route_id)
      .maybeSingle();

    const routeName = route?.route_name || "Unknown Route";

    // Queue notification for all statuses (boarded, absent, dropped_off)
    await queueGuardianNotifications(adminClient, {
      tenant_id: caller.tenant_id,
      student_id: body.student_id,
      notification_type: body.status,
      student_name: student.full_name,
      route_name: routeName,
      stop_name: stop.stop_name,
    });

    // ─── Step 6: Log to audit log ──────────────────────────────────────────────────

    await logAttendanceEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: `attendance_${body.status}`,
      entity_id: attendance.id,
      details: {
        trip_id: body.trip_id,
        student_id: body.student_id,
        student_name: student.full_name,
        stop_id: body.stop_id,
        stop_name: stop.stop_name,
        status: body.status,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        message: `Attendance recorded: ${body.status}`,
        attendance,
      }),
      { status: 201, headers }
    );
  } catch (error) {
    // If verifyCallerRole threw a Response, return it with CORS headers
    if (error instanceof Response) {
      const body = await error.text();
      return new Response(body, {
        status: error.status,
        headers,
      });
    }

    const message =
      error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({
        error: message,
        code: "INTERNAL_ERROR",
      } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
