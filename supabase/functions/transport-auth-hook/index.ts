/**
 * Edge Function: transport-auth-hook
 *
 * Logs authentication events (login, failed_login, logout) to the
 * transport_audit_log table for users with operator or driver roles.
 *
 * This function is called as a Supabase Auth webhook or invoked from
 * the client-side auth state change listener. It filters events to only
 * log transport-related users (those with operator/driver roles).
 *
 * Endpoints:
 *   POST - Log an authentication event
 *
 * Body:
 *   { user_id: string, event: 'login' | 'failed_login' | 'logout', email?: string }
 *
 * Auth: Uses service role key (called from internal hooks) or validates
 *       the request via a shared webhook secret.
 *
 * Requirements: 14.1 (log all authentication events)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthEventRequest {
  user_id: string;
  event: "login" | "failed_login" | "logout";
  email?: string;
  metadata?: Record<string, unknown>;
}

const VALID_EVENTS = ["login", "failed_login", "logout"] as const;

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers }
    );
  }

  try {
    // Validate webhook secret or authorization
    const authHeader = req.headers.get("Authorization");
    const webhookSecret = Deno.env.get("TRANSPORT_AUTH_WEBHOOK_SECRET");

    // Allow either service-role Bearer token or webhook secret
    const isServiceRole = authHeader?.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "___none___");
    const isWebhookAuth = webhookSecret && req.headers.get("x-webhook-secret") === webhookSecret;
    const isBearerAuth = authHeader?.startsWith("Bearer ");

    if (!isServiceRole && !isWebhookAuth && !isBearerAuth) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_MISSING" }),
        { status: 401, headers }
      );
    }

    const body: AuthEventRequest = await req.json();
    const ip = extractIp(req);

    // Validate required fields
    if (!body.user_id || typeof body.user_id !== "string") {
      return new Response(
        JSON.stringify({ error: "user_id is required", code: "VALIDATION_ERROR" }),
        { status: 400, headers }
      );
    }

    if (!body.event || !VALID_EVENTS.includes(body.event as typeof VALID_EVENTS[number])) {
      return new Response(
        JSON.stringify({
          error: `event must be one of: ${VALID_EVENTS.join(", ")}`,
          code: "VALIDATION_ERROR",
        }),
        { status: 400, headers }
      );
    }

    // Create admin client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Call the database function which checks if user is a transport user
    // and only logs if they have operator/driver role
    const { data: logId, error: rpcError } = await adminClient.rpc(
      "log_transport_login_event",
      {
        p_user_id: body.user_id,
        p_event: body.event,
        p_ip: ip,
        p_details: {
          email: body.email || null,
          source: "auth_hook",
          ...(body.metadata || {}),
        },
      }
    );

    if (rpcError) {
      console.error("[transport-auth-hook] RPC error:", rpcError.message);
      return new Response(
        JSON.stringify({
          error: "Failed to log auth event",
          code: "LOG_FAILED",
          details: rpcError.message,
        }),
        { status: 500, headers }
      );
    }

    return new Response(
      JSON.stringify({
        message: "Auth event logged",
        logged: logId !== null, // null means user is not a transport user
        log_id: logId,
      }),
      { status: 200, headers }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message, code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});
