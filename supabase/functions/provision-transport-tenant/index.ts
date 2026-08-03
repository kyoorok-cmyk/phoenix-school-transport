/**
 * Edge Function: provision-transport-tenant
 *
 * Provisions a new transport tenant workspace with an admin user.
 * This function requires `vendor_admin` role authentication — only
 * platform administrators can create new transport tenants.
 *
 * Flow:
 * 1. Authenticate caller and verify vendor_admin role
 * 2. Validate all required fields
 * 3. Create tenant record in `tenants` table (via provision_new_tenant RPC)
 * 4. Create admin user via Supabase Admin API with role='operator' and tenant_id in user_metadata
 * 5. Log provisioning event to `transport_audit_log`
 * 6. On failure at any step, roll back all partially created resources
 * 7. Return tenant_id and admin user_id on success
 *
 * Requirements: 1.1, 1.2, 1.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateEmail, validateRequired } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

interface ProvisionTransportTenantRequest {
  company_name: string;
  admin_email: string;
  admin_full_name: string;
  admin_password?: string;
  subscription_tier: "starter" | "professional" | "enterprise";
}

interface ErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: "Method not allowed",
        code: "METHOD_NOT_ALLOWED",
      } satisfies ErrorResponse),
      { status: 405, headers }
    );
  }

  // --- Authenticate caller and verify vendor_admin role ---
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({
        error: "Missing or invalid authorization header",
        code: "UNAUTHORIZED",
      } satisfies ErrorResponse),
      { status: 401, headers }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Verify the caller's token
  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const {
    data: { user: caller },
    error: authError,
  } = await authClient.auth.getUser(token);

  if (authError || !caller) {
    return new Response(
      JSON.stringify({
        error: "Invalid or expired token",
        code: "UNAUTHORIZED",
      } satisfies ErrorResponse),
      { status: 401, headers }
    );
  }

  const callerRole = caller.user_metadata?.role;

  if (callerRole !== "vendor_admin") {
    return new Response(
      JSON.stringify({
        error: "Forbidden: vendor_admin role required",
        code: "FORBIDDEN",
        details: { required_role: "vendor_admin", current_role: callerRole || "unknown" },
      } satisfies ErrorResponse),
      { status: 403, headers }
    );
  }

  // --- Parse and validate request body ---
  let body: ProvisionTransportTenantRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON body",
        code: "INVALID_REQUEST",
      } satisfies ErrorResponse),
      { status: 400, headers }
    );
  }

  const validationErrors: string[] = [];

  const { missing } = validateRequired(
    {
      company_name: body.company_name,
      admin_email: body.admin_email,
      admin_full_name: body.admin_full_name,
      subscription_tier: body.subscription_tier,
    },
    ["company_name", "admin_email", "admin_full_name", "subscription_tier"]
  );

  if (missing.length > 0) {
    for (const field of missing) {
      validationErrors.push(`${field} is required`);
    }
  }

  // Email format validation
  if (body.admin_email && !validateEmail(body.admin_email.trim())) {
    validationErrors.push("admin_email must be a valid email address");
  }

  // Subscription tier validation
  const validTiers = ["starter", "professional", "enterprise"];
  if (body.subscription_tier && !validTiers.includes(body.subscription_tier)) {
    validationErrors.push(
      "subscription_tier must be one of: starter, professional, enterprise"
    );
  }

  if (validationErrors.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: validationErrors,
      } satisfies ErrorResponse),
      { status: 400, headers }
    );
  }

  // --- Create Supabase admin client (service role) ---
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const clientIp = extractIp(req);
  let tenantId: string | null = null;
  let adminUserId: string | null = null;

  try {
    // --- Step 1: Provision tenant via the atomic SQL function ---
    const { data: newTenantId, error: provisionError } = await adminClient.rpc(
      "provision_new_tenant",
      {
        p_company_name: body.company_name.trim(),
        p_contact_email: body.admin_email.trim(),
        p_contact_phone: null,
        p_physical_address: null,
        p_tier: body.subscription_tier,
      }
    );

    if (provisionError) {
      return new Response(
        JSON.stringify({
          error: "Failed to provision tenant",
          code: "PROVISIONING_FAILED",
          details: provisionError.message,
        } satisfies ErrorResponse),
        { status: 500, headers }
      );
    }

    tenantId = newTenantId as string;

    // --- Step 2: Create admin user via Supabase Auth Admin API ---
    const createUserPayload: {
      email: string;
      email_confirm: boolean;
      password?: string;
      user_metadata: {
        tenant_id: string;
        role: string;
        display_name: string;
      };
    } = {
      email: body.admin_email.trim(),
      email_confirm: true, // Auto-confirm the admin account
      user_metadata: {
        tenant_id: tenantId!,
        role: "operator",
        display_name: body.admin_full_name.trim(),
      },
    };

    // Include password if provided (enables immediate login)
    if (body.admin_password && body.admin_password.trim().length >= 8) {
      createUserPayload.password = body.admin_password.trim();
    }

    const { data: userData, error: userError } =
      await adminClient.auth.admin.createUser(createUserPayload);

    if (userError) {
      // --- Rollback: delete the tenant and subscription we just created ---
      await adminClient
        .from("subscriptions")
        .delete()
        .eq("tenant_id", tenantId);

      await adminClient
        .from("tenants")
        .delete()
        .eq("id", tenantId);

      tenantId = null;

      return new Response(
        JSON.stringify({
          error: "Failed to create admin user",
          code: "USER_CREATION_FAILED",
          details: userError.message,
        } satisfies ErrorResponse),
        { status: 500, headers }
      );
    }

    adminUserId = userData.user.id;

    // --- Step 3: Log provisioning event to transport_audit_log ---
    const { error: auditError } = await adminClient
      .from("transport_audit_log")
      .insert({
        tenant_id: tenantId,
        user_id: caller.id,
        event_type: "tenant_provisioned",
        entity_type: "tenant",
        entity_id: tenantId,
        details: {
          company_name: body.company_name.trim(),
          admin_email: body.admin_email.trim(),
          admin_full_name: body.admin_full_name.trim(),
          subscription_tier: body.subscription_tier,
          admin_user_id: adminUserId,
          provisioned_by: caller.id,
        },
        ip_address: clientIp,
      });

    if (auditError) {
      // Audit log failure is non-critical — log to console but don't roll back
      console.error(
        "[provision-transport-tenant] Failed to write audit log:",
        auditError.message
      );
    }

    // --- Success response ---
    return new Response(
      JSON.stringify({
        message: "Transport tenant provisioned successfully",
        tenant_id: tenantId,
        user_id: adminUserId,
      }),
      { status: 201, headers }
    );
  } catch (error) {
    // --- Rollback on unexpected error ---
    if (adminUserId) {
      try {
        await adminClient.auth.admin.deleteUser(adminUserId);
      } catch (deleteUserErr) {
        console.error(
          "[provision-transport-tenant] Rollback: failed to delete user:",
          deleteUserErr
        );
      }
    }

    if (tenantId) {
      try {
        await adminClient
          .from("subscriptions")
          .delete()
          .eq("tenant_id", tenantId);

        await adminClient
          .from("tenants")
          .delete()
          .eq("id", tenantId);
      } catch (deleteTenantErr) {
        console.error(
          "[provision-transport-tenant] Rollback: failed to delete tenant:",
          deleteTenantErr
        );
      }
    }

    // Log failed provisioning attempt
    try {
      await adminClient
        .from("transport_audit_log")
        .insert({
          tenant_id: tenantId,
          user_id: caller.id,
          event_type: "tenant_provisioning_failed",
          entity_type: "tenant",
          entity_id: null,
          details: {
            company_name: body.company_name?.trim(),
            admin_email: body.admin_email?.trim(),
            subscription_tier: body.subscription_tier,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          ip_address: clientIp,
        });
    } catch (auditErr) {
      console.error(
        "[provision-transport-tenant] Failed to log error event:",
        auditErr
      );
    }

    const message =
      error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({
        error: message,
        code: "INTERNAL_ERROR",
      } satisfies ErrorResponse),
      { status: 500, headers }
    );
  }
});
