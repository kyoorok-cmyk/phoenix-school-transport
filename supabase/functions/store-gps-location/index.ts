/**
 * Edge Function: store-gps-location
 *
 * Stores GPS location data for active trips and broadcasts to Realtime channels.
 * Supports single location submissions and batch mode for offline sync.
 *
 * Auth: Requires `driver`, `operator`, or `admin` role.
 *
 * Body (single):
 *   { trip_id, latitude, longitude, recorded_at, speed_kmh?, heading?, synced_from_offline? }
 *
 * Body (batch):
 *   { locations: [{ trip_id, latitude, longitude, recorded_at, speed_kmh?, heading? }] }
 *
 * Logic:
 * 1. Validate trip exists and is in_progress, belongs to caller's tenant
 * 2. Insert location record(s) into transport_trip_locations
 * 3. Broadcast location to Supabase Realtime channel `trip:{trip_id}:location`
 * 4. Check last location timestamp - if gap > 120 seconds, log signal_lost alert
 * 5. Return success
 *
 * Requirements: 6.2, 7.1, 7.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SingleLocationRequest {
  trip_id: string;
  latitude: number;
  longitude: number;
  recorded_at: string;
  speed_kmh?: number | null;
  heading?: number | null;
  synced_from_offline?: boolean;
}

interface BatchLocationRequest {
  locations: SingleLocationRequest[];
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
const SIGNAL_LOSS_THRESHOLD_SECONDS = 120;

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

// ─── Helper: Validate a single location object ────────────────────────────────

function validateLocation(
  loc: SingleLocationRequest,
  index?: number
): ErrorResponse | null {
  const prefix = index !== undefined ? `locations[${index}].` : "";

  if (!loc.trip_id || !validateUUID(loc.trip_id)) {
    return {
      error: `${prefix}trip_id must be a valid UUID`,
      code: "VALIDATION_ERROR",
      details: { field: `${prefix}trip_id` },
    };
  }

  if (typeof loc.latitude !== "number" || loc.latitude < -90 || loc.latitude > 90) {
    return {
      error: `${prefix}latitude must be a number between -90 and 90`,
      code: "VALIDATION_ERROR",
      details: { field: `${prefix}latitude`, received: loc.latitude },
    };
  }

  if (typeof loc.longitude !== "number" || loc.longitude < -180 || loc.longitude > 180) {
    return {
      error: `${prefix}longitude must be a number between -180 and 180`,
      code: "VALIDATION_ERROR",
      details: { field: `${prefix}longitude`, received: loc.longitude },
    };
  }

  if (!loc.recorded_at || isNaN(Date.parse(loc.recorded_at))) {
    return {
      error: `${prefix}recorded_at must be a valid ISO 8601 timestamp`,
      code: "VALIDATION_ERROR",
      details: { field: `${prefix}recorded_at`, received: loc.recorded_at },
    };
  }

  if (loc.speed_kmh !== undefined && loc.speed_kmh !== null) {
    if (typeof loc.speed_kmh !== "number" || loc.speed_kmh < 0) {
      return {
        error: `${prefix}speed_kmh must be a non-negative number`,
        code: "VALIDATION_ERROR",
        details: { field: `${prefix}speed_kmh`, received: loc.speed_kmh },
      };
    }
  }

  if (loc.heading !== undefined && loc.heading !== null) {
    if (typeof loc.heading !== "number" || loc.heading < 0 || loc.heading > 360) {
      return {
        error: `${prefix}heading must be a number between 0 and 360`,
        code: "VALIDATION_ERROR",
        details: { field: `${prefix}heading`, received: loc.heading },
      };
    }
  }

  return null;
}

// ─── Helper: Log audit event to transport_audit_log ────────────────────────────

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
    console.error("[store-gps-location][audit] Failed to log:", error.message);
  }
}

// ─── Helper: Check for signal loss gap and log alert ───────────────────────────

async function checkSignalLossGap(
  adminClient: ReturnType<typeof createClient>,
  tripId: string,
  tenantId: string,
  userId: string,
  currentRecordedAt: string,
  ip: string
): Promise<boolean> {
  // Get the most recent previous location for this trip
  const { data: lastLocation, error } = await adminClient
    .from("transport_trip_locations")
    .select("recorded_at")
    .eq("trip_id", tripId)
    .lt("recorded_at", currentRecordedAt)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !lastLocation) {
    // No previous location or query error — no gap to detect
    return false;
  }

  const lastTime = new Date(lastLocation.recorded_at).getTime();
  const currentTime = new Date(currentRecordedAt).getTime();
  const gapSeconds = (currentTime - lastTime) / 1000;

  if (gapSeconds > SIGNAL_LOSS_THRESHOLD_SECONDS) {
    // Log signal_lost alert to transport_audit_log
    await logAuditEvent(adminClient, {
      tenant_id: tenantId,
      user_id: userId,
      event_type: "signal_lost",
      entity_type: "trip",
      entity_id: tripId,
      details: {
        gap_seconds: gapSeconds,
        last_recorded_at: lastLocation.recorded_at,
        current_recorded_at: currentRecordedAt,
        threshold_seconds: SIGNAL_LOSS_THRESHOLD_SECONDS,
      },
      ip_address: ip,
    });

    return true;
  }

  return false;
}

// ─── Helper: Broadcast location to Realtime channel ────────────────────────────

async function broadcastLocation(
  adminClient: ReturnType<typeof createClient>,
  tripId: string,
  location: {
    latitude: number;
    longitude: number;
    recorded_at: string;
    speed_kmh?: number | null;
    heading?: number | null;
  }
): Promise<void> {
  try {
    const channel = adminClient.channel(`trip:${tripId}:location`);

    await channel.send({
      type: "broadcast",
      event: "gps_update",
      payload: {
        trip_id: tripId,
        latitude: location.latitude,
        longitude: location.longitude,
        recorded_at: location.recorded_at,
        speed_kmh: location.speed_kmh ?? null,
        heading: location.heading ?? null,
      },
    });

    // Unsubscribe after sending to clean up the channel
    await adminClient.removeChannel(channel);
  } catch (err) {
    console.error(
      "[store-gps-location][broadcast] Failed to broadcast:",
      err instanceof Error ? err.message : err
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
          error: "Method not allowed. Use POST.",
          code: "METHOD_NOT_ALLOWED",
        } as ErrorResponse),
        { status: 405, headers }
      );
    }

    // Verify caller role
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

    const adminClient = getAdminClient();

    // Determine if this is a batch request or a single location
    const isBatch = Array.isArray((body as BatchLocationRequest).locations);
    const locations: SingleLocationRequest[] = isBatch
      ? (body as BatchLocationRequest).locations
      : [body as unknown as SingleLocationRequest];

    // Validate batch size
    if (locations.length === 0) {
      return new Response(
        JSON.stringify({
          error: "At least one location is required",
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    if (locations.length > 500) {
      return new Response(
        JSON.stringify({
          error: "Batch size exceeds maximum of 500 locations",
          code: "VALIDATION_ERROR",
          details: { max_batch_size: 500, received: locations.length },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate all locations
    for (let i = 0; i < locations.length; i++) {
      const validationError = validateLocation(
        locations[i],
        isBatch ? i : undefined
      );
      if (validationError) {
        return new Response(JSON.stringify(validationError), {
          status: 400,
          headers,
        });
      }
    }

    // Group locations by trip_id for trip validation
    const tripLocationMap = new Map<string, SingleLocationRequest[]>();
    for (const loc of locations) {
      const existing = tripLocationMap.get(loc.trip_id) || [];
      existing.push(loc);
      tripLocationMap.set(loc.trip_id, existing);
    }

    // Validate all referenced trips exist, are in_progress, and belong to caller's tenant
    const tripIds = [...tripLocationMap.keys()];
    const { data: trips, error: tripsError } = await adminClient
      .from("transport_trips")
      .select("id, tenant_id, driver_id, status")
      .in("id", tripIds)
      .eq("tenant_id", caller.tenant_id);

    if (tripsError) {
      return new Response(
        JSON.stringify({
          error: "Failed to fetch trips",
          code: "INTERNAL_ERROR",
          details: tripsError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // Check all trips were found
    const foundTripIds = new Set((trips || []).map((t) => t.id));
    const missingTrips = tripIds.filter((id) => !foundTripIds.has(id));
    if (missingTrips.length > 0) {
      return new Response(
        JSON.stringify({
          error: "One or more trips not found or do not belong to your tenant",
          code: "NOT_FOUND",
          details: { missing_trip_ids: missingTrips },
        } as ErrorResponse),
        { status: 404, headers }
      );
    }

    // Validate all trips are in_progress
    const nonActiveTrips = (trips || []).filter((t) => t.status !== "in_progress");
    if (nonActiveTrips.length > 0) {
      return new Response(
        JSON.stringify({
          error: "GPS locations can only be recorded for trips that are in progress",
          code: "TRIP_NOT_IN_PROGRESS",
          details: {
            non_active_trips: nonActiveTrips.map((t) => ({
              trip_id: t.id,
              current_status: t.status,
            })),
          },
        } as ErrorResponse),
        { status: 409, headers }
      );
    }

    // If caller is a driver, verify they are assigned to all referenced trips
    if (caller.role === "driver") {
      const unownedTrips = (trips || []).filter((t) => t.driver_id !== caller.id);
      if (unownedTrips.length > 0) {
        return new Response(
          JSON.stringify({
            error: "Forbidden: one or more trips are not assigned to you",
            code: "AUTH_FORBIDDEN",
            details: { unowned_trip_ids: unownedTrips.map((t) => t.id) },
          } as ErrorResponse),
          { status: 403, headers }
        );
      }
    }

    // ─── Insert location records ───────────────────────────────────────────────

    const locationRecords = locations.map((loc) => ({
      trip_id: loc.trip_id,
      tenant_id: caller.tenant_id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      recorded_at: loc.recorded_at,
      speed_kmh: loc.speed_kmh ?? null,
      heading: loc.heading ?? null,
      synced_from_offline: loc.synced_from_offline ?? false,
    }));

    const { data: insertedLocations, error: insertError } = await adminClient
      .from("transport_trip_locations")
      .insert(locationRecords)
      .select();

    if (insertError) {
      return new Response(
        JSON.stringify({
          error: "Failed to store GPS locations",
          code: "INSERT_FAILED",
          details: insertError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // ─── Broadcast and signal loss detection ───────────────────────────────────

    const signalLossAlerts: string[] = [];

    // For each trip, broadcast the latest location and check for signal loss
    for (const [tripId, tripLocations] of tripLocationMap.entries()) {
      // Sort locations by recorded_at to find the latest
      const sorted = [...tripLocations].sort(
        (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
      );

      // Broadcast the most recent location for this trip
      const latestLocation = sorted[sorted.length - 1];
      await broadcastLocation(adminClient, tripId, {
        latitude: latestLocation.latitude,
        longitude: latestLocation.longitude,
        recorded_at: latestLocation.recorded_at,
        speed_kmh: latestLocation.speed_kmh,
        heading: latestLocation.heading,
      });

      // Check signal loss gap for the earliest location in this batch
      // (comparing against the last known location before this batch)
      const earliestLocation = sorted[0];
      const hasGap = await checkSignalLossGap(
        adminClient,
        tripId,
        caller.tenant_id,
        caller.id,
        earliestLocation.recorded_at,
        ip
      );

      if (hasGap) {
        signalLossAlerts.push(tripId);
      }
    }

    return new Response(
      JSON.stringify({
        message: `Successfully stored ${insertedLocations?.length || locations.length} GPS location(s)`,
        locations_stored: insertedLocations?.length || locations.length,
        signal_loss_detected: signalLossAlerts.length > 0,
        signal_loss_trip_ids: signalLossAlerts.length > 0 ? signalLossAlerts : undefined,
      }),
      { status: 201, headers }
    );
  } catch (err) {
    // If the error is already a Response (thrown by verifyCallerRole), return it
    if (err instanceof Response) {
      const body = await err.text();
      return new Response(body, {
        status: err.status,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    console.error("[store-gps-location] Unhandled error:", err);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      } as ErrorResponse),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
