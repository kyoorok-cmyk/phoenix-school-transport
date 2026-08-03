/**
 * Edge Function: manage-transport-users
 *
 * Manages user accounts for transport tenants with operator and driver roles.
 *
 * Endpoints:
 *   POST   - Create a new user with role (operator|driver) in user_metadata
 *   PUT    - Deactivate/reactivate a user; revokes sessions on deactivation
 *
 * All auth events (user_created, user_deactivated, session_revoked) are
 * logged to the transport_audit_log table.
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * Requirements: 2.1, 2.2, 2.4, 14.1
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateEmail, validateRequired, validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateUserRequest {
  email: string;
  full_name: string;
  role: "operator" | "driver";
  tenant_id: string;
}

interface DeactivateUserRequest {
  user_id: string;
  active: boolean;
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

// ─── Allowed roles for transport users ─────────────────────────────────────────

const TRANSPORT_ROLES = ["operator", "driver"] as const;
const ALLOWED_CALLER_ROLES = ["operator", "admin"] as const;

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

// ─── Helper: Log transport auth event ──────────────────────────────────────────

async function logTransportAuthEvent(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    user_id: string | null;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    details: Record<string, unknown>;
    ip_address: string;
  }
): Promise<void> {
  // Validate IP for INET compatibility — default to 0.0.0.0 for invalid values
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
    console.error("[transport-audit] Failed to log event:", error.message, params);
  }
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

// ─── Handler: POST - Create user ───────────────────────────────────────────────

async function handleCreateUser(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const body: CreateUserRequest = await req.json();
  const ip = extractIp(req);

  // Validate required fields
  const { missing } = validateRequired(
    {
      email: body.email,
      full_name: body.full_name,
      role: body.role,
      tenant_id: body.tenant_id,
    },
    ["email", "full_name", "role", "tenant_id"]
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

  // Validate email format
  if (!validateEmail(body.email.trim())) {
    return new Response(
      JSON.stringify({
        error: "Invalid email format",
        code: "VALIDATION_ERROR",
        details: "email must be a valid email address",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate role
  if (!TRANSPORT_ROLES.includes(body.role as typeof TRANSPORT_ROLES[number])) {
    return new Response(
      JSON.stringify({
        error: "Invalid role",
        code: "VALIDATION_ERROR",
        details: `role must be one of: ${TRANSPORT_ROLES.join(", ")}`,
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate tenant_id format
  if (!validateUUID(body.tenant_id)) {
    return new Response(
      JSON.stringify({
        error: "Invalid tenant_id format",
        code: "VALIDATION_ERROR",
        details: "tenant_id must be a valid UUID",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Ensure caller belongs to the same tenant
  if (caller.tenant_id !== body.tenant_id) {
    return new Response(
      JSON.stringify({
        error: "Forbidden: cannot create users for a different tenant",
        code: "AUTH_FORBIDDEN",
      } as ErrorResponse),
      { status: 403, headers }
    );
  }

  const adminClient = getAdminClient();

  // Create user via Supabase Admin API with role and tenant_id in user_metadata
  const { data: userData, error: createError } =
    await adminClient.auth.admin.createUser({
      email: body.email.trim(),
      email_confirm: true,
      user_metadata: {
        tenant_id: body.tenant_id,
        role: body.role,
        display_name: body.full_name.trim(),
      },
    });

  if (createError) {
    // Log the failed creation attempt
    await logTransportAuthEvent(adminClient, {
      tenant_id: body.tenant_id,
      user_id: caller.id,
      event_type: "user_creation_failed",
      entity_type: "user",
      entity_id: null,
      details: {
        email: body.email,
        role: body.role,
        error: createError.message,
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        error: "Failed to create user",
        code: "CREATE_FAILED",
        details: createError.message,
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Log successful user creation
  await logTransportAuthEvent(adminClient, {
    tenant_id: body.tenant_id,
    user_id: caller.id,
    event_type: "user_created",
    entity_type: "user",
    entity_id: userData.user.id,
    details: {
      email: body.email,
      full_name: body.full_name,
      role: body.role,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "User created successfully",
      user_id: userData.user.id,
      email: userData.user.email,
      role: body.role,
    }),
    { status: 201, headers }
  );
}

// ─── Handler: PUT - Deactivate/reactivate user ─────────────────────────────────

async function handleUpdateUser(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const body: DeactivateUserRequest = await req.json();
  const ip = extractIp(req);

  // Validate required fields
  if (!body.user_id || typeof body.user_id !== "string") {
    return new Response(
      JSON.stringify({
        error: "user_id is required",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  if (!validateUUID(body.user_id)) {
    return new Response(
      JSON.stringify({
        error: "Invalid user_id format",
        code: "VALIDATION_ERROR",
        details: "user_id must be a valid UUID",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  if (typeof body.active !== "boolean") {
    return new Response(
      JSON.stringify({
        error: "active field is required and must be a boolean",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Fetch target user to verify they belong to the same tenant
  const { data: targetUserData, error: fetchError } =
    await adminClient.auth.admin.getUserById(body.user_id);

  if (fetchError || !targetUserData?.user) {
    return new Response(
      JSON.stringify({
        error: "User not found",
        code: "NOT_FOUND",
      } as ErrorResponse),
      { status: 404, headers }
    );
  }

  const targetUser = targetUserData.user;
  const targetTenantId = targetUser.user_metadata?.tenant_id;

  // Ensure caller belongs to the same tenant as the target user
  if (caller.tenant_id !== targetTenantId) {
    return new Response(
      JSON.stringify({
        error: "Forbidden: cannot modify users from a different tenant",
        code: "AUTH_FORBIDDEN",
      } as ErrorResponse),
      { status: 403, headers }
    );
  }

  // Prevent self-deactivation
  if (body.user_id === caller.id && !body.active) {
    return new Response(
      JSON.stringify({
        error: "Cannot deactivate your own account",
        code: "SELF_DEACTIVATION",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  if (!body.active) {
    // ─── Deactivation flow ─────────────────────────────────────────────────────

    // 1. Ban the user (prevents new logins and marks as inactive)
    const { error: banError } = await adminClient.auth.admin.updateUserById(
      body.user_id,
      { ban_duration: "876000h" } // ~100 years effectively permanent ban
    );

    if (banError) {
      return new Response(
        JSON.stringify({
          error: "Failed to deactivate user",
          code: "DEACTIVATION_FAILED",
          details: banError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // 2. Revoke all active sessions (within 60 seconds requirement)
    // Supabase admin.signOut will revoke all sessions for the user
    const { error: signOutError } = await adminClient.auth.admin.signOut(
      body.user_id,
      "global"
    );

    if (signOutError) {
      // Log session revocation failure but don't block deactivation
      console.error(
        "[manage-transport-users] Failed to revoke sessions:",
        signOutError.message
      );
    }

    // 3. Log user deactivation
    await logTransportAuthEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "user_deactivated",
      entity_type: "user",
      entity_id: body.user_id,
      details: {
        target_user_email: targetUser.email,
        target_user_role: targetUser.user_metadata?.role,
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    // 4. Log session revocation
    await logTransportAuthEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "session_revoked",
      entity_type: "user_session",
      entity_id: body.user_id,
      details: {
        target_user_email: targetUser.email,
        reason: "user_deactivated",
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        message: "User deactivated and sessions revoked",
        user_id: body.user_id,
        active: false,
      }),
      { status: 200, headers }
    );
  } else {
    // ─── Reactivation flow ─────────────────────────────────────────────────────

    // Remove ban (re-enable login)
    const { error: unbanError } = await adminClient.auth.admin.updateUserById(
      body.user_id,
      { ban_duration: "none" }
    );

    if (unbanError) {
      return new Response(
        JSON.stringify({
          error: "Failed to reactivate user",
          code: "REACTIVATION_FAILED",
          details: unbanError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // Log user reactivation
    await logTransportAuthEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "user_reactivated",
      entity_type: "user",
      entity_id: body.user_id,
      details: {
        target_user_email: targetUser.email,
        target_user_role: targetUser.user_metadata?.role,
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        message: "User reactivated",
        user_id: body.user_id,
        active: true,
      }),
      { status: 200, headers }
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
    // Verify caller has operator or admin role
    const caller = await verifyCallerRole(req);

    switch (req.method) {
      case "POST":
        return await handleCreateUser(req, caller, headers);
      case "PUT":
        return await handleUpdateUser(req, caller, headers);
      default:
        return new Response(
          JSON.stringify({
            error: "Method not allowed",
            code: "METHOD_NOT_ALLOWED",
          } as ErrorResponse),
          { status: 405, headers }
        );
    }
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
