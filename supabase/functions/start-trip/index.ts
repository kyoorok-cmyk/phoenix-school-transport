/**
 * Edge Function: start-trip
 *
 * Marks a trip as in_progress and records the actual departure timestamp.
 * Called by a driver (or operator/admin) to signal the beginning of a trip.
 *
 * Body: { trip_id: string }
 *
 * Auth: Requires `driver`, `operator`, or `admin` role.
 *       If role is `driver`, the trip's driver_id must match the caller.
 *
 * Requirements: 6.2, 6.6, 14.3
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateUUID } from "../_shared/validation.ts";
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

const ALLOWED_CALLER_ROLES = ["driver", "operator", "admin"] as const;

// ─── Helper: Verify caller has driver, operator, or admin role ─────────────────

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
    console.error("[start-trip][audit] Failed to log:", error.message);
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
        JSON.stringify({ error: "Method not allowed. Use POST.", code: "METHOD_NOT_ALLOWED" } as ErrorResponse),
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

    const tripId = body.trip_id as string;

    // Validate trip_id
    if (!tripId || !validateUUID(tripId)) {
      return new Response(
        JSON.stringify({ error: "Valid trip_id is required", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const adminClient = getAdminClient();

    // Fetch the trip and validate it belongs to the caller's tenant
    const { data: trip, error: fetchError } = await adminClient
      .from("transport_trips")
      .select("*")
      .eq("id", tripId)
      .eq("tenant_id", caller.tenant_id)
      .single();

    if (fetchError || !trip) {
      return new Response(
        JSON.stringify({ error: "Trip not found or does not belong to your tenant", code: "NOT_FOUND" } as ErrorResponse),
        { status: 404, headers }
      );
    }

    // Validate trip status is 'scheduled'
    if (trip.status !== "scheduled") {
      return new Response(
        JSON.stringify({
          error: "Trip cannot be started: current status is not 'scheduled'",
          code: "INVALID_STATUS",
          details: { current_status: trip.status },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // If caller is a driver, verify they own the trip
    if (caller.role === "driver" && trip.driver_id !== caller.id) {
      return new Response(
        JSON.stringify({
          error: "Forbidden: this trip is not assigned to you",
          code: "AUTH_FORBIDDEN",
        } as ErrorResponse),
        { status: 403, headers }
      );
    }

    // Update trip: set status to in_progress and actual_departure to now
    const now = new Date().toISOString();
    const { data: updatedTrip, error: updateError } = await adminClient
      .from("transport_trips")
      .update({
        status: "in_progress",
        actual_departure: now,
      })
      .eq("id", tripId)
      .eq("tenant_id", caller.tenant_id)
      .select()
      .single();

    if (updateError || !updatedTrip) {
      return new Response(
        JSON.stringify({ error: "Failed to start trip", code: "UPDATE_FAILED", details: updateError?.message } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // Log trip_started event to audit log
    await logAuditEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "trip_started",
      entity_type: "trip",
      entity_id: tripId,
      details: {
        trip_date: trip.trip_date,
        trip_type: trip.trip_type,
        route_id: trip.route_id,
        vehicle_id: trip.vehicle_id,
        driver_id: trip.driver_id,
        actual_departure: now,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        message: "Trip started successfully",
        trip: updatedTrip,
      }),
      { status: 200, headers }
    );
  } catch (err) {
    // If the error is already a Response (thrown by verifyCallerRole), return it
    if (err instanceof Response) {
      return err;
    }

    console.error("[start-trip] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR" } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
