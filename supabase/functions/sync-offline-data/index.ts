/**
 * Edge Function: sync-offline-data
 *
 * Batch-syncs offline-queued attendance records and GPS locations from the Driver App.
 *
 * Auth: Requires `driver`, `operator`, or `admin` role.
 * Body: {
 *   attendance_records: [{ trip_id, student_id, stop_id, status, recorded_at, latitude?, longitude? }],
 *   gps_locations: [{ trip_id, latitude, longitude, recorded_at, speed_kmh?, heading? }]
 * }
 *
 * Logic:
 * 1. Sort attendance_records by recorded_at ascending (FIFO - Property 25)
 * 2. Sort gps_locations by recorded_at ascending (FIFO)
 * 3. For each attendance record:
 *    - Insert into transport_attendance with synced_from_offline=true
 *    - On conflict (duplicate trip+student+status), resolve using last-write-wins by timestamp (Property 26)
 *    - Queue guardian notification for the attendance event
 * 4. For GPS locations, bulk insert into transport_trip_locations with synced_from_offline=true
 * 5. Wrap in logical batch - if any attendance insert fails, continue with the rest (best-effort)
 * 6. Return summary: { attendance_synced, attendance_conflicts, gps_synced, errors }
 *
 * Requirements: 12.1, 12.2, 12.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttendanceRecord {
  trip_id: string;
  student_id: string;
  stop_id: string;
  status: "boarded" | "absent" | "dropped_off";
  recorded_at: string;
  latitude?: number | null;
  longitude?: number | null;
}

interface GpsLocation {
  trip_id: string;
  latitude: number;
  longitude: number;
  recorded_at: string;
  speed_kmh?: number | null;
  heading?: number | null;
}

interface SyncRequest {
  attendance_records?: AttendanceRecord[];
  gps_locations?: GpsLocation[];
}

interface SyncSummary {
  attendance_synced: number;
  attendance_conflicts: number;
  gps_synced: number;
  errors: string[];
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
      "[sync-offline-data][notify] No guardians found for student:",
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
      "[sync-offline-data][notify] Failed to fetch guardian details:",
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
      "[sync-offline-data][notify] Failed to queue notifications:",
      insertError.message
    );
  }
}

// ─── Helper: Validate a single attendance record ───────────────────────────────

function validateAttendanceRecord(
  record: AttendanceRecord,
  index: number
): string | null {
  if (!record.trip_id || !validateUUID(record.trip_id)) {
    return `attendance_records[${index}]: invalid or missing trip_id`;
  }
  if (!record.student_id || !validateUUID(record.student_id)) {
    return `attendance_records[${index}]: invalid or missing student_id`;
  }
  if (!record.stop_id || !validateUUID(record.stop_id)) {
    return `attendance_records[${index}]: invalid or missing stop_id`;
  }
  if (!record.status || !VALID_STATUSES.includes(record.status as typeof VALID_STATUSES[number])) {
    return `attendance_records[${index}]: invalid status (must be boarded, absent, or dropped_off)`;
  }
  if (!record.recorded_at) {
    return `attendance_records[${index}]: missing recorded_at timestamp`;
  }
  // Validate recorded_at is a parseable date
  if (isNaN(Date.parse(record.recorded_at))) {
    return `attendance_records[${index}]: invalid recorded_at timestamp`;
  }
  // Validate optional GPS coordinates
  if (record.latitude !== undefined && record.latitude !== null) {
    if (typeof record.latitude !== "number" || record.latitude < -90 || record.latitude > 90) {
      return `attendance_records[${index}]: latitude must be between -90 and 90`;
    }
  }
  if (record.longitude !== undefined && record.longitude !== null) {
    if (typeof record.longitude !== "number" || record.longitude < -180 || record.longitude > 180) {
      return `attendance_records[${index}]: longitude must be between -180 and 180`;
    }
  }
  return null;
}

// ─── Helper: Validate a single GPS location record ─────────────────────────────

function validateGpsLocation(location: GpsLocation, index: number): string | null {
  if (!location.trip_id || !validateUUID(location.trip_id)) {
    return `gps_locations[${index}]: invalid or missing trip_id`;
  }
  if (typeof location.latitude !== "number" || location.latitude < -90 || location.latitude > 90) {
    return `gps_locations[${index}]: latitude must be a number between -90 and 90`;
  }
  if (typeof location.longitude !== "number" || location.longitude < -180 || location.longitude > 180) {
    return `gps_locations[${index}]: longitude must be a number between -180 and 180`;
  }
  if (!location.recorded_at) {
    return `gps_locations[${index}]: missing recorded_at timestamp`;
  }
  if (isNaN(Date.parse(location.recorded_at))) {
    return `gps_locations[${index}]: invalid recorded_at timestamp`;
  }
  if (location.speed_kmh !== undefined && location.speed_kmh !== null) {
    if (typeof location.speed_kmh !== "number" || location.speed_kmh < 0) {
      return `gps_locations[${index}]: speed_kmh must be a non-negative number`;
    }
  }
  if (location.heading !== undefined && location.heading !== null) {
    if (typeof location.heading !== "number" || location.heading < 0 || location.heading > 360) {
      return `gps_locations[${index}]: heading must be between 0 and 360`;
    }
  }
  return null;
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
    let body: SyncRequest;
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

    const attendanceRecords = body.attendance_records || [];
    const gpsLocations = body.gps_locations || [];

    // Validate that at least some data is provided
    if (attendanceRecords.length === 0 && gpsLocations.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No data to sync: both attendance_records and gps_locations are empty",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate all attendance records
    const attendanceErrors: string[] = [];
    for (let i = 0; i < attendanceRecords.length; i++) {
      const err = validateAttendanceRecord(attendanceRecords[i], i);
      if (err) attendanceErrors.push(err);
    }

    // Validate all GPS locations
    const gpsErrors: string[] = [];
    for (let i = 0; i < gpsLocations.length; i++) {
      const err = validateGpsLocation(gpsLocations[i], i);
      if (err) gpsErrors.push(err);
    }

    // If there are validation errors, return them
    const validationErrors = [...attendanceErrors, ...gpsErrors];
    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          details: validationErrors,
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const adminClient = getAdminClient();
    const summary: SyncSummary = {
      attendance_synced: 0,
      attendance_conflicts: 0,
      gps_synced: 0,
      errors: [],
    };

    // ─── Step 1 & 2: Sort by recorded_at ascending (FIFO - Property 25) ──────────

    const sortedAttendance = [...attendanceRecords].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );

    const sortedGps = [...gpsLocations].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );

    // ─── Step 3: Process attendance records (best-effort) ────────────────────────

    // Pre-fetch trip and student/stop data to minimize per-record lookups
    const tripIds = [...new Set(sortedAttendance.map((r) => r.trip_id))];
    const studentIds = [...new Set(sortedAttendance.map((r) => r.student_id))];
    const stopIds = [...new Set(sortedAttendance.map((r) => r.stop_id))];

    // Fetch trips to get route_ids and validate they belong to caller's tenant
    let tripsMap: Map<string, { route_id: string; status: string }> = new Map();
    if (tripIds.length > 0) {
      const { data: trips, error: tripsError } = await adminClient
        .from("transport_trips")
        .select("id, route_id, status")
        .in("id", tripIds)
        .eq("tenant_id", caller.tenant_id);

      if (tripsError) {
        console.error("[sync-offline-data] Failed to fetch trips:", tripsError.message);
      } else if (trips) {
        tripsMap = new Map(trips.map((t) => [t.id, { route_id: t.route_id, status: t.status }]));
      }
    }

    // Fetch students for notification names
    let studentsMap: Map<string, { full_name: string; assigned_route_id: string }> = new Map();
    if (studentIds.length > 0) {
      const { data: students, error: studentsError } = await adminClient
        .from("transport_students")
        .select("id, full_name, assigned_route_id")
        .in("id", studentIds)
        .eq("tenant_id", caller.tenant_id);

      if (studentsError) {
        console.error("[sync-offline-data] Failed to fetch students:", studentsError.message);
      } else if (students) {
        studentsMap = new Map(
          students.map((s) => [s.id, { full_name: s.full_name, assigned_route_id: s.assigned_route_id }])
        );
      }
    }

    // Fetch stops for notification names
    let stopsMap: Map<string, { stop_name: string; route_id: string }> = new Map();
    if (stopIds.length > 0) {
      const { data: stops, error: stopsError } = await adminClient
        .from("transport_stops")
        .select("id, stop_name, route_id")
        .in("id", stopIds);

      if (stopsError) {
        console.error("[sync-offline-data] Failed to fetch stops:", stopsError.message);
      } else if (stops) {
        stopsMap = new Map(stops.map((s) => [s.id, { stop_name: s.stop_name, route_id: s.route_id }]));
      }
    }

    // Fetch route names for notifications
    const routeIds = [...new Set([...tripsMap.values()].map((t) => t.route_id))];
    let routesMap: Map<string, string> = new Map();
    if (routeIds.length > 0) {
      const { data: routes, error: routesError } = await adminClient
        .from("transport_routes")
        .select("id, route_name")
        .in("id", routeIds);

      if (routesError) {
        console.error("[sync-offline-data] Failed to fetch routes:", routesError.message);
      } else if (routes) {
        routesMap = new Map(routes.map((r) => [r.id, r.route_name]));
      }
    }

    // Process each attendance record individually (best-effort: continue on failure)
    for (const record of sortedAttendance) {
      try {
        const trip = tripsMap.get(record.trip_id);
        if (!trip) {
          summary.errors.push(
            `Attendance skipped: trip ${record.trip_id} not found or not in tenant`
          );
          continue;
        }

        // Check for existing record to implement last-write-wins (Property 26)
        const { data: existing, error: existingError } = await adminClient
          .from("transport_attendance")
          .select("id, recorded_at")
          .eq("trip_id", record.trip_id)
          .eq("student_id", record.student_id)
          .eq("status", record.status)
          .maybeSingle();

        if (existingError) {
          summary.errors.push(
            `Attendance error checking conflict for trip=${record.trip_id}, student=${record.student_id}: ${existingError.message}`
          );
          continue;
        }

        if (existing) {
          // Conflict detected: apply last-write-wins by timestamp (Property 26)
          const existingTime = new Date(existing.recorded_at).getTime();
          const incomingTime = new Date(record.recorded_at).getTime();

          if (incomingTime > existingTime) {
            // Incoming record wins: update the existing record
            const { error: updateError } = await adminClient
              .from("transport_attendance")
              .update({
                stop_id: record.stop_id,
                recorded_at: record.recorded_at,
                latitude: record.latitude ?? null,
                longitude: record.longitude ?? null,
                synced_from_offline: true,
              })
              .eq("id", existing.id);

            if (updateError) {
              summary.errors.push(
                `Attendance conflict update failed for trip=${record.trip_id}, student=${record.student_id}: ${updateError.message}`
              );
            } else {
              summary.attendance_conflicts++;
              summary.attendance_synced++;
            }
          } else {
            // Server record wins: skip the incoming record
            summary.attendance_conflicts++;
          }
        } else {
          // No conflict: insert new record
          const { error: insertError } = await adminClient
            .from("transport_attendance")
            .insert({
              tenant_id: caller.tenant_id,
              trip_id: record.trip_id,
              student_id: record.student_id,
              stop_id: record.stop_id,
              status: record.status,
              recorded_at: record.recorded_at,
              latitude: record.latitude ?? null,
              longitude: record.longitude ?? null,
              synced_from_offline: true,
            });

          if (insertError) {
            // Handle unique constraint violations that may occur from race conditions
            if (insertError.code === "23505") {
              summary.attendance_conflicts++;
            } else {
              summary.errors.push(
                `Attendance insert failed for trip=${record.trip_id}, student=${record.student_id}: ${insertError.message}`
              );
            }
            continue;
          }

          summary.attendance_synced++;
        }

        // Queue guardian notification for the attendance event
        const student = studentsMap.get(record.student_id);
        const stop = stopsMap.get(record.stop_id);
        const routeId = trip.route_id;
        const routeName = routesMap.get(routeId) || "Unknown Route";

        if (student && stop) {
          await queueGuardianNotifications(adminClient, {
            tenant_id: caller.tenant_id,
            student_id: record.student_id,
            notification_type: record.status,
            student_name: student.full_name,
            route_name: routeName,
            stop_name: stop.stop_name,
          });
        }
      } catch (recordError) {
        const message = recordError instanceof Error ? recordError.message : "Unknown error";
        summary.errors.push(
          `Attendance processing error for trip=${record.trip_id}, student=${record.student_id}: ${message}`
        );
      }
    }

    // ─── Step 4: Bulk insert GPS locations ───────────────────────────────────────

    if (sortedGps.length > 0) {
      // Validate trip_ids belong to caller's tenant
      const gpsTripIds = [...new Set(sortedGps.map((g) => g.trip_id))];
      const validGpsTripIds = new Set<string>();

      if (gpsTripIds.length > 0) {
        // Re-use tripsMap if GPS trip IDs overlap, otherwise fetch additional
        const missingTripIds = gpsTripIds.filter((id) => !tripsMap.has(id));

        if (missingTripIds.length > 0) {
          const { data: additionalTrips } = await adminClient
            .from("transport_trips")
            .select("id")
            .in("id", missingTripIds)
            .eq("tenant_id", caller.tenant_id);

          if (additionalTrips) {
            additionalTrips.forEach((t) => validGpsTripIds.add(t.id));
          }
        }

        // Add trips already in our map
        gpsTripIds.forEach((id) => {
          if (tripsMap.has(id)) validGpsTripIds.add(id);
        });
      }

      // Filter GPS locations to only those with valid trip IDs
      const validGpsRecords = sortedGps.filter((g) => validGpsTripIds.has(g.trip_id));
      const skippedGps = sortedGps.length - validGpsRecords.length;

      if (skippedGps > 0) {
        summary.errors.push(
          `${skippedGps} GPS location(s) skipped: trip_id not found or not in tenant`
        );
      }

      if (validGpsRecords.length > 0) {
        // Prepare bulk insert payload
        const gpsInsertPayload = validGpsRecords.map((g) => ({
          trip_id: g.trip_id,
          tenant_id: caller.tenant_id,
          latitude: g.latitude,
          longitude: g.longitude,
          recorded_at: g.recorded_at,
          speed_kmh: g.speed_kmh ?? null,
          heading: g.heading ?? null,
          synced_from_offline: true,
        }));

        // Bulk insert in batches of 100 to avoid payload size issues
        const BATCH_SIZE = 100;
        for (let i = 0; i < gpsInsertPayload.length; i += BATCH_SIZE) {
          const batch = gpsInsertPayload.slice(i, i + BATCH_SIZE);
          const { error: gpsInsertError } = await adminClient
            .from("transport_trip_locations")
            .insert(batch);

          if (gpsInsertError) {
            summary.errors.push(
              `GPS bulk insert failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${gpsInsertError.message}`
            );
          } else {
            summary.gps_synced += batch.length;
          }
        }
      }
    }

    // ─── Step 6: Log sync event to audit log ─────────────────────────────────────

    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+$/;
    const safeIp = ipRegex.test(ip) ? ip : "0.0.0.0";

    await adminClient.from("transport_audit_log").insert({
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "offline_sync",
      entity_type: "sync_batch",
      entity_id: null,
      details: {
        attendance_synced: summary.attendance_synced,
        attendance_conflicts: summary.attendance_conflicts,
        gps_synced: summary.gps_synced,
        errors_count: summary.errors.length,
        total_attendance_submitted: attendanceRecords.length,
        total_gps_submitted: gpsLocations.length,
      },
      ip_address: safeIp,
    });

    // ─── Return summary ──────────────────────────────────────────────────────────

    return new Response(
      JSON.stringify({
        message: "Offline sync completed",
        summary,
      }),
      { status: 200, headers }
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
