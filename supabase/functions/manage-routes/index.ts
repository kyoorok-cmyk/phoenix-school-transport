/**
 * Edge Function: manage-routes
 *
 * CRUD operations for transport routes and stops within routes.
 *
 * Endpoints (via URL path parsing):
 *   GET    /routes              - List all routes for the tenant
 *   GET    /routes/:id          - Get route with its stops
 *   POST   /routes              - Create a route (optionally with stops)
 *   PUT    /routes/:id          - Update route details
 *   DELETE /routes/:id          - Delete a route
 *   POST   /routes/:id/stops          - Add a stop to a route
 *   PUT    /routes/:id/stops/:stop_id - Update a stop
 *   DELETE /routes/:id/stops/:stop_id - Remove a stop
 *   PUT    /routes/:id/stops/reorder  - Reorder stops
 *
 * Auth: operator or admin for write ops; driver can GET routes.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5, 14.2
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

interface StopInput {
  stop_name: string;
  latitude: number;
  longitude: number;
  geofence_radius_meters?: number;
  stop_order: number;
}

interface ReorderItem {
  stop_id: string;
  new_order: number;
}

// ─── Allowed roles ────────────────────────────────────────────────────────────

const WRITE_ROLES = ["operator", "admin"] as const;
const READ_ROLES = ["operator", "admin", "driver"] as const;

// ─── Helper: Verify caller role ───────────────────────────────────────────────

async function verifyCallerRole(
  req: Request,
  allowedRoles: readonly string[]
): Promise<CallerInfo> {
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

  if (!allowedRoles.includes(role)) {
    throw new Response(
      JSON.stringify({
        error: `Forbidden: one of [${allowedRoles.join(", ")}] role required`,
        code: "AUTH_FORBIDDEN",
        details: { required_roles: [...allowedRoles], current_role: role || "unknown" },
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

// ─── Helper: Create admin Supabase client ─────────────────────────────────────

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

// ─── Helper: Log audit event ──────────────────────────────────────────────────

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
    console.error("[manage-routes][audit] Failed to log event:", error.message);
  }
}

// ─── Helper: Notify assigned drivers of route modification ────────────────────

async function notifyAssignedDrivers(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  routeId: string,
  modificationDetails: Record<string, unknown>
): Promise<{ notified_count: number }> {
  // Query active schedules for this route to find assigned drivers
  const { data: schedules, error: schedError } = await adminClient
    .from("transport_schedules")
    .select("driver_id")
    .eq("route_id", routeId)
    .eq("tenant_id", tenantId)
    .eq("is_active", true);

  if (schedError || !schedules || schedules.length === 0) {
    return { notified_count: 0 };
  }

  // Get unique driver IDs
  const driverIds = [...new Set(schedules.map((s) => s.driver_id))];

  // Log push notification for each driver
  // (Actual FCM integration comes in task 11; for now we log the intent)
  for (const driverId of driverIds) {
    await adminClient.from("transport_audit_log").insert({
      tenant_id: tenantId,
      user_id: driverId,
      event_type: "push_notification_queued",
      entity_type: "route",
      entity_id: routeId,
      details: {
        notification_type: "route_modified",
        driver_id: driverId,
        modification: modificationDetails,
      },
      ip_address: "0.0.0.0",
    });
  }

  return { notified_count: driverIds.length };
}

// ─── Helper: Parse URL path segments ──────────────────────────────────────────

function parsePath(url: string): string[] {
  const urlObj = new URL(url);
  // Path format: /manage-routes/routes/:id/stops/:stop_id
  // Remove the function name prefix and split
  const parts = urlObj.pathname
    .split("/")
    .filter((p) => p !== "" && p !== "manage-routes");
  return parts;
}

// ─── Helper: Validate stop input ──────────────────────────────────────────────

function validateStopInput(stop: StopInput): string[] {
  const errors: string[] = [];

  if (!stop.stop_name || stop.stop_name.trim() === "") {
    errors.push("stop_name is required");
  }

  if (typeof stop.latitude !== "number" || stop.latitude < -90 || stop.latitude > 90) {
    errors.push("latitude must be a number between -90 and 90");
  }

  if (typeof stop.longitude !== "number" || stop.longitude < -180 || stop.longitude > 180) {
    errors.push("longitude must be a number between -180 and 180");
  }

  if (stop.geofence_radius_meters !== undefined) {
    if (
      typeof stop.geofence_radius_meters !== "number" ||
      stop.geofence_radius_meters < 10 ||
      stop.geofence_radius_meters > 5000
    ) {
      errors.push("geofence_radius_meters must be between 10 and 5000");
    }
  }

  if (typeof stop.stop_order !== "number" || stop.stop_order < 1) {
    errors.push("stop_order must be a positive integer");
  }

  return errors;
}

// ─── Handler: GET /routes - List all routes for tenant ────────────────────────

async function handleListRoutes(
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const adminClient = getAdminClient();

  const { data: routes, error } = await adminClient
    .from("transport_routes")
    .select("*")
    .eq("tenant_id", caller.tenant_id)
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch routes",
        code: "FETCH_FAILED",
        details: error.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  return new Response(JSON.stringify({ routes: routes || [] }), {
    status: 200,
    headers,
  });
}

// ─── Handler: GET /routes/:id - Get route with stops ──────────────────────────

async function handleGetRoute(
  routeId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid route ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  const { data: route, error: routeError } = await adminClient
    .from("transport_routes")
    .select("*")
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (routeError || !route) {
    return new Response(
      JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Fetch stops for this route ordered by stop_order
  const { data: stops, error: stopsError } = await adminClient
    .from("transport_stops")
    .select("*")
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .order("stop_order", { ascending: true });

  if (stopsError) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch stops",
        code: "FETCH_FAILED",
        details: stopsError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  return new Response(
    JSON.stringify({ route, stops: stops || [] }),
    { status: 200, headers }
  );
}

// ─── Handler: POST /routes - Create a route ───────────────────────────────────

async function handleCreateRoute(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const body = await req.json();
  const ip = extractIp(req);

  // Validate required route fields
  const { missing } = validateRequired(
    {
      route_name: body.route_name,
      school_name: body.school_name,
      estimated_travel_minutes: body.estimated_travel_minutes,
    },
    ["route_name", "school_name", "estimated_travel_minutes"]
  );

  if (missing.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: missing.map((f) => `${f} is required`),
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate estimated_travel_minutes > 0
  if (
    typeof body.estimated_travel_minutes !== "number" ||
    body.estimated_travel_minutes <= 0
  ) {
    return new Response(
      JSON.stringify({
        error: "estimated_travel_minutes must be a positive number",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate monthly_fee if provided
  if (body.monthly_fee !== undefined && body.monthly_fee !== null) {
    if (typeof body.monthly_fee !== "number" || body.monthly_fee < 0) {
      return new Response(
        JSON.stringify({
          error: "monthly_fee must be a non-negative number",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Validate stops if provided
  const stops: StopInput[] = body.stops || [];
  if (stops.length > 0) {
    for (let i = 0; i < stops.length; i++) {
      const stopErrors = validateStopInput(stops[i]);
      if (stopErrors.length > 0) {
        return new Response(
          JSON.stringify({
            error: `Validation failed for stop at index ${i}`,
            code: "VALIDATION_ERROR",
            details: stopErrors,
          } as ErrorResponse),
          { status: 400, headers }
        );
      }
    }
  }

  const adminClient = getAdminClient();

  // Insert the route
  const { data: route, error: routeError } = await adminClient
    .from("transport_routes")
    .insert({
      tenant_id: caller.tenant_id,
      route_name: body.route_name.trim(),
      school_name: body.school_name.trim(),
      estimated_travel_minutes: body.estimated_travel_minutes,
      monthly_fee: body.monthly_fee ?? 0.0,
      is_active: body.is_active ?? true,
    })
    .select()
    .single();

  if (routeError || !route) {
    return new Response(
      JSON.stringify({
        error: "Failed to create route",
        code: "CREATE_FAILED",
        details: routeError?.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Insert stops if provided
  let createdStops: unknown[] = [];
  if (stops.length > 0) {
    const stopRecords = stops.map((s) => ({
      route_id: route.id,
      tenant_id: caller.tenant_id,
      stop_name: s.stop_name.trim(),
      latitude: s.latitude,
      longitude: s.longitude,
      geofence_radius_meters: s.geofence_radius_meters ?? 100,
      stop_order: s.stop_order,
    }));

    const { data: stopsData, error: stopsError } = await adminClient
      .from("transport_stops")
      .insert(stopRecords)
      .select();

    if (stopsError) {
      // Route was created but stops failed — log and return partial success
      console.error("[manage-routes] Failed to create stops:", stopsError.message);
      return new Response(
        JSON.stringify({
          error: "Route created but failed to create stops",
          code: "PARTIAL_SUCCESS",
          details: stopsError.message,
          route,
        }),
        { status: 207, headers }
      );
    }

    createdStops = stopsData || [];
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "route_created",
    entity_type: "route",
    entity_id: route.id,
    details: {
      route_name: route.route_name,
      school_name: route.school_name,
      stops_count: createdStops.length,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Route created successfully",
      route,
      stops: createdStops,
    }),
    { status: 201, headers }
  );
}

// ─── Handler: PUT /routes/:id - Update route ──────────────────────────────────

async function handleUpdateRoute(
  req: Request,
  routeId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid route ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const body = await req.json();
  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Verify route exists and belongs to tenant
  const { data: existing, error: fetchError } = await adminClient
    .from("transport_routes")
    .select("*")
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchError || !existing) {
    return new Response(
      JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Build update object from allowed fields
  const updateFields: Record<string, unknown> = {};

  if (body.route_name !== undefined) {
    if (!body.route_name || body.route_name.trim() === "") {
      return new Response(
        JSON.stringify({
          error: "route_name cannot be empty",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.route_name = body.route_name.trim();
  }

  if (body.school_name !== undefined) {
    if (!body.school_name || body.school_name.trim() === "") {
      return new Response(
        JSON.stringify({
          error: "school_name cannot be empty",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.school_name = body.school_name.trim();
  }

  if (body.estimated_travel_minutes !== undefined) {
    if (
      typeof body.estimated_travel_minutes !== "number" ||
      body.estimated_travel_minutes <= 0
    ) {
      return new Response(
        JSON.stringify({
          error: "estimated_travel_minutes must be a positive number",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.estimated_travel_minutes = body.estimated_travel_minutes;
  }

  if (body.monthly_fee !== undefined) {
    if (typeof body.monthly_fee !== "number" || body.monthly_fee < 0) {
      return new Response(
        JSON.stringify({
          error: "monthly_fee must be a non-negative number",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.monthly_fee = body.monthly_fee;
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return new Response(
        JSON.stringify({
          error: "is_active must be a boolean",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.is_active = body.is_active;
  }

  if (Object.keys(updateFields).length === 0) {
    return new Response(
      JSON.stringify({
        error: "No valid fields to update",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  updateFields.updated_at = new Date().toISOString();

  // Perform update
  const { data: updated, error: updateError } = await adminClient
    .from("transport_routes")
    .update(updateFields)
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .select()
    .single();

  if (updateError) {
    return new Response(
      JSON.stringify({
        error: "Failed to update route",
        code: "UPDATE_FAILED",
        details: updateError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "route_updated",
    entity_type: "route",
    entity_id: routeId,
    details: {
      changes: updateFields,
      previous: existing,
    },
    ip_address: ip,
  });

  // Notify assigned drivers of route modification (Requirement 4.5)
  const { notified_count } = await notifyAssignedDrivers(
    adminClient,
    caller.tenant_id,
    routeId,
    updateFields
  );

  return new Response(
    JSON.stringify({
      message: "Route updated successfully",
      route: updated,
      drivers_notified: notified_count,
    }),
    { status: 200, headers }
  );
}

// ─── Handler: DELETE /routes/:id - Delete a route ─────────────────────────────

async function handleDeleteRoute(
  req: Request,
  routeId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid route ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Verify route exists and belongs to tenant
  const { data: existing, error: fetchError } = await adminClient
    .from("transport_routes")
    .select("*")
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchError || !existing) {
    return new Response(
      JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Check for active schedules on this route
  const { data: activeSchedules } = await adminClient
    .from("transport_schedules")
    .select("id")
    .eq("route_id", routeId)
    .eq("is_active", true)
    .limit(1);

  if (activeSchedules && activeSchedules.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Cannot delete route with active schedules",
        code: "DELETE_BLOCKED",
        details: "Deactivate or remove all schedules for this route first",
      } as ErrorResponse),
      { status: 409, headers }
    );
  }

  // Delete route (stops cascade via ON DELETE CASCADE)
  const { error: deleteError } = await adminClient
    .from("transport_routes")
    .delete()
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id);

  if (deleteError) {
    return new Response(
      JSON.stringify({
        error: "Failed to delete route",
        code: "DELETE_FAILED",
        details: deleteError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "route_deleted",
    entity_type: "route",
    entity_id: routeId,
    details: {
      route_name: existing.route_name,
      school_name: existing.school_name,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Route deleted successfully", route_id: routeId }),
    { status: 200, headers }
  );
}

// ─── Handler: POST /routes/:id/stops - Add a stop to a route ──────────────────

async function handleAddStop(
  req: Request,
  routeId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid route ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const body = await req.json();
  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Verify route exists and belongs to tenant
  const { data: route, error: routeError } = await adminClient
    .from("transport_routes")
    .select("id")
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (routeError || !route) {
    return new Response(
      JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Validate stop input
  const stopInput: StopInput = {
    stop_name: body.stop_name,
    latitude: body.latitude,
    longitude: body.longitude,
    geofence_radius_meters: body.geofence_radius_meters,
    stop_order: body.stop_order,
  };

  const stopErrors = validateStopInput(stopInput);
  if (stopErrors.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: stopErrors,
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Insert the stop
  const { data: stop, error: insertError } = await adminClient
    .from("transport_stops")
    .insert({
      route_id: routeId,
      tenant_id: caller.tenant_id,
      stop_name: stopInput.stop_name.trim(),
      latitude: stopInput.latitude,
      longitude: stopInput.longitude,
      geofence_radius_meters: stopInput.geofence_radius_meters ?? 100,
      stop_order: stopInput.stop_order,
    })
    .select()
    .single();

  if (insertError) {
    return new Response(
      JSON.stringify({
        error: "Failed to add stop",
        code: "CREATE_FAILED",
        details: insertError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "stop_added",
    entity_type: "stop",
    entity_id: stop.id,
    details: {
      route_id: routeId,
      stop_name: stop.stop_name,
      stop_order: stop.stop_order,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Stop added successfully", stop }),
    { status: 201, headers }
  );
}

// ─── Handler: PUT /routes/:id/stops/:stop_id - Update a stop ──────────────────

async function handleUpdateStop(
  req: Request,
  routeId: string,
  stopId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId) || !validateUUID(stopId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const body = await req.json();
  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Verify stop exists and belongs to route + tenant
  const { data: existing, error: fetchError } = await adminClient
    .from("transport_stops")
    .select("*")
    .eq("id", stopId)
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchError || !existing) {
    return new Response(
      JSON.stringify({ error: "Stop not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Build update object
  const updateFields: Record<string, unknown> = {};

  if (body.stop_name !== undefined) {
    if (!body.stop_name || body.stop_name.trim() === "") {
      return new Response(
        JSON.stringify({
          error: "stop_name cannot be empty",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.stop_name = body.stop_name.trim();
  }

  if (body.latitude !== undefined) {
    if (typeof body.latitude !== "number" || body.latitude < -90 || body.latitude > 90) {
      return new Response(
        JSON.stringify({
          error: "latitude must be between -90 and 90",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.latitude = body.latitude;
  }

  if (body.longitude !== undefined) {
    if (typeof body.longitude !== "number" || body.longitude < -180 || body.longitude > 180) {
      return new Response(
        JSON.stringify({
          error: "longitude must be between -180 and 180",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.longitude = body.longitude;
  }

  if (body.geofence_radius_meters !== undefined) {
    if (
      typeof body.geofence_radius_meters !== "number" ||
      body.geofence_radius_meters < 10 ||
      body.geofence_radius_meters > 5000
    ) {
      return new Response(
        JSON.stringify({
          error: "geofence_radius_meters must be between 10 and 5000",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.geofence_radius_meters = body.geofence_radius_meters;
  }

  if (body.stop_order !== undefined) {
    if (typeof body.stop_order !== "number" || body.stop_order < 1) {
      return new Response(
        JSON.stringify({
          error: "stop_order must be a positive integer",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updateFields.stop_order = body.stop_order;
  }

  if (Object.keys(updateFields).length === 0) {
    return new Response(
      JSON.stringify({
        error: "No valid fields to update",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Perform update
  const { data: updated, error: updateError } = await adminClient
    .from("transport_stops")
    .update(updateFields)
    .eq("id", stopId)
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .select()
    .single();

  if (updateError) {
    return new Response(
      JSON.stringify({
        error: "Failed to update stop",
        code: "UPDATE_FAILED",
        details: updateError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "stop_updated",
    entity_type: "stop",
    entity_id: stopId,
    details: {
      route_id: routeId,
      changes: updateFields,
      previous: existing,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Stop updated successfully", stop: updated }),
    { status: 200, headers }
  );
}

// ─── Handler: DELETE /routes/:id/stops/:stop_id - Remove a stop ───────────────

async function handleDeleteStop(
  req: Request,
  routeId: string,
  stopId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId) || !validateUUID(stopId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Verify stop exists
  const { data: existing, error: fetchError } = await adminClient
    .from("transport_stops")
    .select("*")
    .eq("id", stopId)
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchError || !existing) {
    return new Response(
      JSON.stringify({ error: "Stop not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Check if any students are assigned to this stop
  const { data: assignedStudents } = await adminClient
    .from("transport_students")
    .select("id")
    .eq("assigned_stop_id", stopId)
    .eq("tenant_id", caller.tenant_id)
    .limit(1);

  if (assignedStudents && assignedStudents.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Cannot delete stop with assigned students",
        code: "DELETE_BLOCKED",
        details: "Reassign students to another stop first",
      } as ErrorResponse),
      { status: 409, headers }
    );
  }

  // Delete the stop
  const { error: deleteError } = await adminClient
    .from("transport_stops")
    .delete()
    .eq("id", stopId)
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id);

  if (deleteError) {
    return new Response(
      JSON.stringify({
        error: "Failed to delete stop",
        code: "DELETE_FAILED",
        details: deleteError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "stop_deleted",
    entity_type: "stop",
    entity_id: stopId,
    details: {
      route_id: routeId,
      stop_name: existing.stop_name,
      stop_order: existing.stop_order,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({ message: "Stop deleted successfully", stop_id: stopId }),
    { status: 200, headers }
  );
}

// ─── Handler: PUT /routes/:id/stops/reorder - Reorder stops ───────────────────

async function handleReorderStops(
  req: Request,
  routeId: string,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  if (!validateUUID(routeId)) {
    return new Response(
      JSON.stringify({
        error: "Invalid route ID format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const body = await req.json();
  const ip = extractIp(req);
  const adminClient = getAdminClient();

  // Validate reorder payload
  const reorderItems: ReorderItem[] = body.stops;

  if (!Array.isArray(reorderItems) || reorderItems.length === 0) {
    return new Response(
      JSON.stringify({
        error: "stops array is required with at least one item",
        code: "VALIDATION_ERROR",
        details: "Expected: { stops: [{ stop_id, new_order }] }",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate each item
  for (const item of reorderItems) {
    if (!item.stop_id || !validateUUID(item.stop_id)) {
      return new Response(
        JSON.stringify({
          error: "Each item must have a valid stop_id (UUID)",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    if (typeof item.new_order !== "number" || item.new_order < 1) {
      return new Response(
        JSON.stringify({
          error: "Each item must have new_order as a positive integer",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Check for duplicate orders
  const orders = reorderItems.map((i) => i.new_order);
  if (new Set(orders).size !== orders.length) {
    return new Response(
      JSON.stringify({
        error: "Duplicate new_order values are not allowed",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Verify route exists and belongs to tenant
  const { data: route, error: routeError } = await adminClient
    .from("transport_routes")
    .select("id")
    .eq("id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (routeError || !route) {
    return new Response(
      JSON.stringify({ error: "Route not found", code: "NOT_FOUND" } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Use a temporary large offset to avoid unique constraint conflicts during reorder.
  // First set all to temporary values (offset by 10000), then set final values.
  const tempOffset = 10000;

  // Step 1: Set temporary stop_order values
  for (const item of reorderItems) {
    const { error } = await adminClient
      .from("transport_stops")
      .update({ stop_order: tempOffset + item.new_order })
      .eq("id", item.stop_id)
      .eq("route_id", routeId)
      .eq("tenant_id", caller.tenant_id);

    if (error) {
      return new Response(
        JSON.stringify({
          error: "Failed to reorder stops (phase 1)",
          code: "REORDER_FAILED",
          details: error.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }
  }

  // Step 2: Set final stop_order values
  for (const item of reorderItems) {
    const { error } = await adminClient
      .from("transport_stops")
      .update({ stop_order: item.new_order })
      .eq("id", item.stop_id)
      .eq("route_id", routeId)
      .eq("tenant_id", caller.tenant_id);

    if (error) {
      return new Response(
        JSON.stringify({
          error: "Failed to reorder stops (phase 2)",
          code: "REORDER_FAILED",
          details: error.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }
  }

  // Fetch updated stops for response
  const { data: updatedStops } = await adminClient
    .from("transport_stops")
    .select("*")
    .eq("route_id", routeId)
    .eq("tenant_id", caller.tenant_id)
    .order("stop_order", { ascending: true });

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "stops_reordered",
    entity_type: "route",
    entity_id: routeId,
    details: {
      reorder: reorderItems,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Stops reordered successfully",
      stops: updatedStops || [],
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
    const method = req.method;
    const path = parsePath(req.url);

    // Determine which roles are required based on method
    const allowedRoles = method === "GET" ? READ_ROLES : WRITE_ROLES;
    const caller = await verifyCallerRole(req, allowedRoles);

    // ─── Route: GET /routes ─────────────────────────────────────
    if (method === "GET" && path.length === 1 && path[0] === "routes") {
      return await handleListRoutes(caller, headers);
    }

    // ─── Route: GET /routes/:id ─────────────────────────────────
    if (method === "GET" && path.length === 2 && path[0] === "routes") {
      return await handleGetRoute(path[1], caller, headers);
    }

    // ─── Route: POST /routes ────────────────────────────────────
    if (method === "POST" && path.length === 1 && path[0] === "routes") {
      return await handleCreateRoute(req, caller, headers);
    }

    // ─── Route: PUT /routes/:id ─────────────────────────────────
    if (method === "PUT" && path.length === 2 && path[0] === "routes") {
      return await handleUpdateRoute(req, path[1], caller, headers);
    }

    // ─── Route: DELETE /routes/:id ──────────────────────────────
    if (method === "DELETE" && path.length === 2 && path[0] === "routes") {
      return await handleDeleteRoute(req, path[1], caller, headers);
    }

    // ─── Route: PUT /routes/:id/stops/reorder ───────────────────
    if (
      method === "PUT" &&
      path.length === 4 &&
      path[0] === "routes" &&
      path[2] === "stops" &&
      path[3] === "reorder"
    ) {
      return await handleReorderStops(req, path[1], caller, headers);
    }

    // ─── Route: POST /routes/:id/stops ──────────────────────────
    if (
      method === "POST" &&
      path.length === 3 &&
      path[0] === "routes" &&
      path[2] === "stops"
    ) {
      return await handleAddStop(req, path[1], caller, headers);
    }

    // ─── Route: PUT /routes/:id/stops/:stop_id ──────────────────
    if (
      method === "PUT" &&
      path.length === 4 &&
      path[0] === "routes" &&
      path[2] === "stops"
    ) {
      return await handleUpdateStop(req, path[1], path[3], caller, headers);
    }

    // ─── Route: DELETE /routes/:id/stops/:stop_id ────────────────
    if (
      method === "DELETE" &&
      path.length === 4 &&
      path[0] === "routes" &&
      path[2] === "stops"
    ) {
      return await handleDeleteStop(req, path[1], path[3], caller, headers);
    }

    // ─── No matching route ──────────────────────────────────────
    return new Response(
      JSON.stringify({
        error: "Not found",
        code: "NOT_FOUND",
        details: `${method} /${path.join("/")} is not a valid endpoint`,
      } as ErrorResponse),
      { status: 404, headers }
    );
  } catch (error) {
    // If verifyCallerRole threw a Response, return it with CORS headers
    if (error instanceof Response) {
      const body = await error.text();
      return new Response(body, { status: error.status, headers });
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
