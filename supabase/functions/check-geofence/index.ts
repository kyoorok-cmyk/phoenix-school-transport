/**
 * Edge Function: check-geofence
 *
 * Evaluates a vehicle GPS position against stop geofences on the active route.
 * Detects geofence entry, approaching stops (ETA ≤ 5 min), and route deviation.
 *
 * Auth: System function (service role or driver role)
 * Body: { trip_id, latitude, longitude, speed_kmh?, heading? }
 *
 * Returns:
 *   {
 *     in_geofence: boolean,
 *     geofence_stop?: { stop_id, stop_name, distance_m },
 *     approaching_stops: [{ stop_id, stop_name, distance_m, eta_minutes }],
 *     route_deviation: boolean,
 *     deviation_distance_m?: number
 *   }
 *
 * Requirements: 6.3, 7.3, 8.1
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateRequired, validateUUID } from "../_shared/validation.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Earth radius in meters */
const EARTH_RADIUS_M = 6_371_000;

/** ETA threshold for approaching notification (minutes) */
const APPROACHING_ETA_MINUTES = 5;

/** Route deviation threshold in meters */
const ROUTE_DEVIATION_THRESHOLD_M = 500;

/** Default speed assumption when speed_kmh is not provided (km/h) */
const DEFAULT_SPEED_KMH = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckGeofenceRequest {
  trip_id: string;
  latitude: number;
  longitude: number;
  speed_kmh?: number;
  heading?: number;
}

interface StopRecord {
  id: string;
  stop_name: string;
  latitude: number;
  longitude: number;
  geofence_radius_meters: number;
  stop_order: number;
}

interface GeofenceStopResult {
  stop_id: string;
  stop_name: string;
  distance_m: number;
}

interface ApproachingStopResult {
  stop_id: string;
  stop_name: string;
  distance_m: number;
  eta_minutes: number;
}

interface CheckGeofenceResponse {
  in_geofence: boolean;
  geofence_stop?: GeofenceStopResult;
  approaching_stops: ApproachingStopResult[];
  route_deviation: boolean;
  deviation_distance_m?: number;
}

// ─── Pure Haversine Distance Function ─────────────────────────────────────────

/**
 * Calculates the haversine distance in meters between two geographic points.
 *
 * This is a pure function with no side effects, exported for testing.
 *
 * @param lat1 - Latitude of point 1 in degrees
 * @param lng1 - Longitude of point 1 in degrees
 * @param lat2 - Latitude of point 2 in degrees
 * @param lng2 - Longitude of point 2 in degrees
 * @returns Distance in meters
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}

// ─── Helper: Point-to-segment distance ────────────────────────────────────────

/**
 * Calculates the minimum distance from a point to a line segment (great-circle approximation).
 * Uses a flat-earth approximation for short segments which is acceptable for route deviation checks.
 *
 * @param pLat - Point latitude in degrees
 * @param pLng - Point longitude in degrees
 * @param aLat - Segment start latitude in degrees
 * @param aLng - Segment start longitude in degrees
 * @param bLat - Segment end latitude in degrees
 * @param bLng - Segment end longitude in degrees
 * @returns Distance in meters from the point to the nearest point on the segment
 */
export function pointToSegmentDistance(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  // Convert to a local coordinate system (meters) using equirectangular approximation
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad((aLat + bLat + pLat) / 3));

  // Project to flat coordinates (meters)
  const px = (pLng - aLng) * cosLat * (EARTH_RADIUS_M * Math.PI / 180);
  const py = (pLat - aLat) * (EARTH_RADIUS_M * Math.PI / 180);
  const bx = (bLng - aLng) * cosLat * (EARTH_RADIUS_M * Math.PI / 180);
  const by = (bLat - aLat) * (EARTH_RADIUS_M * Math.PI / 180);

  // Calculate projection of point onto segment
  const segLenSq = bx * bx + by * by;

  if (segLenSq === 0) {
    // Segment is actually a point; return distance to that point
    return haversineDistance(pLat, pLng, aLat, aLng);
  }

  // Parameterized position along segment [0, 1]
  let t = (px * bx + py * by) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  // Nearest point on segment in lat/lng
  const nearestLat = aLat + t * (bLat - aLat);
  const nearestLng = aLng + t * (bLng - aLng);

  return haversineDistance(pLat, pLng, nearestLat, nearestLng);
}

// ─── Helper: Calculate ETA in minutes ─────────────────────────────────────────

/**
 * Calculates estimated time of arrival in minutes given distance and speed.
 *
 * @param distanceM - Distance in meters
 * @param speedKmh - Speed in km/h
 * @returns ETA in minutes
 */
export function calculateEtaMinutes(distanceM: number, speedKmh: number): number {
  if (speedKmh <= 0) return Infinity;
  const speedMs = (speedKmh * 1000) / 3600; // Convert km/h to m/s
  const timeSeconds = distanceM / speedMs;
  return timeSeconds / 60;
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

// ─── Helper: Verify caller is system or driver ────────────────────────────────

async function verifyCallerAuth(req: Request): Promise<void> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Response(
      JSON.stringify({
        error: "Missing or invalid authorization header",
        code: "AUTH_MISSING",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // If the token matches the service role key, it's a system call
  if (token === supabaseServiceRoleKey) {
    return;
  }

  // Otherwise, verify as a user token
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
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const role = user.user_metadata?.role;
  const allowedRoles = ["driver", "operator", "admin"];

  if (!allowedRoles.includes(role)) {
    throw new Response(
      JSON.stringify({
        error: "Forbidden: driver, operator, or admin role required",
        code: "AUTH_FORBIDDEN",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ─── Helper: Queue approaching notification ───────────────────────────────────

async function queueApproachingNotification(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  stopId: string,
  tripId: string,
  etaMinutes: number
): Promise<void> {
  // Find students assigned to this stop
  const { data: students, error: studentsError } = await adminClient
    .from("transport_students")
    .select("id, full_name, assigned_stop_id")
    .eq("assigned_stop_id", stopId)
    .eq("status", "active");

  if (studentsError || !students || students.length === 0) {
    return;
  }

  // For each student, find their guardians and queue notifications
  for (const student of students) {
    const { data: guardianLinks } = await adminClient
      .from("transport_student_guardians")
      .select("guardian_id")
      .eq("student_id", student.id);

    if (!guardianLinks || guardianLinks.length === 0) continue;

    for (const link of guardianLinks) {
      // Get guardian's preferred channel
      const { data: guardian } = await adminClient
        .from("transport_guardians")
        .select("id, preferred_notification_channel")
        .eq("id", link.guardian_id)
        .single();

      if (!guardian) continue;

      // Insert notification record
      await adminClient.from("transport_notifications").insert({
        tenant_id: tenantId,
        guardian_id: guardian.id,
        notification_type: "approaching",
        channel: guardian.preferred_notification_channel || "sms",
        template_name: "vehicle_approaching",
        template_params: {
          student_name: student.full_name,
          eta_minutes: Math.round(etaMinutes),
          trip_id: tripId,
          stop_id: stopId,
        },
        delivery_status: "pending",
      });
    }
  }
}

// ─── Helper: Queue route deviation alert ──────────────────────────────────────

async function queueDeviationAlert(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  tripId: string,
  deviationDistanceM: number,
  latitude: number,
  longitude: number
): Promise<void> {
  // Log deviation as an audit event for the operator
  await adminClient.from("transport_audit_log").insert({
    tenant_id: tenantId,
    user_id: null,
    event_type: "route_deviation_detected",
    entity_type: "trip",
    entity_id: tripId,
    details: {
      deviation_distance_m: Math.round(deviationDistanceM),
      latitude,
      longitude,
      detected_at: new Date().toISOString(),
    },
    ip_address: "0.0.0.0",
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = {
    ...getCorsHeaders(req),
    "Content-Type": "application/json",
  };

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers }
    );
  }

  try {
    // Verify auth
    await verifyCallerAuth(req);

    // Parse and validate body
    const body: CheckGeofenceRequest = await req.json();

    const { missing } = validateRequired(
      {
        trip_id: body.trip_id,
        latitude: body.latitude,
        longitude: body.longitude,
      },
      ["trip_id", "latitude", "longitude"]
    );

    if (missing.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          details: missing.map((f) => `${f} is required`),
        }),
        { status: 400, headers }
      );
    }

    if (!validateUUID(body.trip_id)) {
      return new Response(
        JSON.stringify({
          error: "Invalid trip_id format",
          code: "VALIDATION_ERROR",
        }),
        { status: 400, headers }
      );
    }

    if (
      typeof body.latitude !== "number" ||
      body.latitude < -90 ||
      body.latitude > 90
    ) {
      return new Response(
        JSON.stringify({
          error: "latitude must be a number between -90 and 90",
          code: "VALIDATION_ERROR",
        }),
        { status: 400, headers }
      );
    }

    if (
      typeof body.longitude !== "number" ||
      body.longitude < -180 ||
      body.longitude > 180
    ) {
      return new Response(
        JSON.stringify({
          error: "longitude must be a number between -180 and 180",
          code: "VALIDATION_ERROR",
        }),
        { status: 400, headers }
      );
    }

    const speedKmh =
      body.speed_kmh && body.speed_kmh > 0
        ? body.speed_kmh
        : DEFAULT_SPEED_KMH;

    const adminClient = getAdminClient();

    // 1. Fetch the trip and its route
    const { data: trip, error: tripError } = await adminClient
      .from("transport_trips")
      .select("id, route_id, tenant_id, status")
      .eq("id", body.trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(
        JSON.stringify({ error: "Trip not found", code: "NOT_FOUND" }),
        { status: 404, headers }
      );
    }

    if (trip.status !== "in_progress") {
      return new Response(
        JSON.stringify({
          error: "Trip is not in progress",
          code: "INVALID_STATE",
          details: { current_status: trip.status },
        }),
        { status: 400, headers }
      );
    }

    // 2. Fetch all stops for the route, ordered by stop_order
    const { data: stops, error: stopsError } = await adminClient
      .from("transport_stops")
      .select("id, stop_name, latitude, longitude, geofence_radius_meters, stop_order")
      .eq("route_id", trip.route_id)
      .order("stop_order", { ascending: true });

    if (stopsError || !stops || stops.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No stops found for route",
          code: "NO_STOPS",
        }),
        { status: 404, headers }
      );
    }

    // 3. Fetch attendance records to determine which stops are already visited
    const { data: attendanceRecords } = await adminClient
      .from("transport_attendance")
      .select("stop_id, status")
      .eq("trip_id", body.trip_id);

    const visitedStopIds = new Set(
      (attendanceRecords || [])
        .filter((r) => r.status === "boarded" || r.status === "dropped_off")
        .map((r) => r.stop_id)
    );

    // 4. For each stop, calculate haversine distance from current position
    const typedStops = stops as StopRecord[];
    let geofenceStop: GeofenceStopResult | undefined;
    const approachingStops: ApproachingStopResult[] = [];
    let minDistanceToRoute = Infinity;

    for (const stop of typedStops) {
      const distance = haversineDistance(
        body.latitude,
        body.longitude,
        stop.latitude,
        stop.longitude
      );

      // Track minimum distance to any stop for deviation check
      if (distance < minDistanceToRoute) {
        minDistanceToRoute = distance;
      }

      // Check geofence entry: distance ≤ geofence_radius_meters
      if (distance <= stop.geofence_radius_meters && !geofenceStop) {
        geofenceStop = {
          stop_id: stop.id,
          stop_name: stop.stop_name,
          distance_m: Math.round(distance),
        };
      }

      // Check ETA for unvisited stops
      if (!visitedStopIds.has(stop.id)) {
        const etaMinutes = calculateEtaMinutes(distance, speedKmh);

        if (etaMinutes <= APPROACHING_ETA_MINUTES && distance > (stop.geofence_radius_meters || 100)) {
          approachingStops.push({
            stop_id: stop.id,
            stop_name: stop.stop_name,
            distance_m: Math.round(distance),
            eta_minutes: Math.round(etaMinutes * 10) / 10,
          });
        }
      }
    }

    // 5. Check route deviation using point-to-segment distance
    // The route polyline is defined by the stops in order
    let minSegmentDistance = Infinity;

    if (typedStops.length >= 2) {
      for (let i = 0; i < typedStops.length - 1; i++) {
        const segDist = pointToSegmentDistance(
          body.latitude,
          body.longitude,
          typedStops[i].latitude,
          typedStops[i].longitude,
          typedStops[i + 1].latitude,
          typedStops[i + 1].longitude
        );

        if (segDist < minSegmentDistance) {
          minSegmentDistance = segDist;
        }
      }
    } else {
      // Only one stop — use distance to that stop
      minSegmentDistance = minDistanceToRoute;
    }

    const routeDeviation = minSegmentDistance > ROUTE_DEVIATION_THRESHOLD_M;

    // 6. Queue notifications as needed
    // Queue approaching notifications for guardians
    for (const approaching of approachingStops) {
      await queueApproachingNotification(
        adminClient,
        trip.tenant_id,
        approaching.stop_id,
        trip.id,
        approaching.eta_minutes
      );
    }

    // Queue deviation alert if route deviation detected
    if (routeDeviation) {
      await queueDeviationAlert(
        adminClient,
        trip.tenant_id,
        trip.id,
        minSegmentDistance,
        body.latitude,
        body.longitude
      );
    }

    // 7. Build and return response
    const response: CheckGeofenceResponse = {
      in_geofence: !!geofenceStop,
      approaching_stops: approachingStops,
      route_deviation: routeDeviation,
    };

    if (geofenceStop) {
      response.geofence_stop = geofenceStop;
    }

    if (routeDeviation) {
      response.deviation_distance_m = Math.round(minSegmentDistance);
    }

    return new Response(JSON.stringify(response), { status: 200, headers });
  } catch (err) {
    // If the error is already a Response (from auth checks), return it
    if (err instanceof Response) {
      return err;
    }

    console.error("[check-geofence] Unexpected error:", err);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      }),
      { status: 500, headers }
    );
  }
});
