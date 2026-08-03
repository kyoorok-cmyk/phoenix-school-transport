/**
 * Edge Function: record-payment (Transport Billing)
 *
 * Records a payment against a transport invoice.
 * Updates invoice status to 'paid' when total payments >= invoice amount.
 * Logs payment to the transport audit log.
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * POST body:
 * {
 *   invoice_id: string,          // UUID of the transport invoice
 *   amount: number,              // Payment amount (> 0)
 *   payment_method: string,      // 'eft' | 'cash' | 'card' | 'debit_order'
 *   payment_date?: string,       // ISO date YYYY-MM-DD (defaults to today)
 *   reference?: string           // Optional payment reference
 * }
 *
 * Returns:
 * {
 *   payment_id: string,
 *   invoice_status: string
 * }
 *
 * Requirements: 10.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateUUID, validateAmount, sanitizeInput } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecordPaymentRequest {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date?: string;
  reference?: string;
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

const ALLOWED_CALLER_ROLES = ["operator", "admin"] as const;
const VALID_PAYMENT_METHODS = ["eft", "cash", "card", "debit_order"] as const;

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

// ─── Helper: Create admin Supabase client ──────────────────────────────────────

function getAdminClient(): ReturnType<typeof createClient> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Helper: Validate date format (YYYY-MM-DD) ────────────────────────────────

function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  // Ensure parsed date matches input (catches 2024-02-30 etc.)
  const [year, month, day] = dateStr.split("-").map(Number);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

// ─── Helper: Log transport audit event ─────────────────────────────────────────

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
    console.error("[record-payment][audit] Failed to log event:", error.message);
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };

  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" } as ErrorResponse),
      { status: 405, headers }
    );
  }

  try {
    // Verify caller has operator or admin role
    const caller = await verifyCallerRole(req);
    const ip = extractIp(req);

    // Parse request body
    let body: RecordPaymentRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // ─── Validation ─────────────────────────────────────────────────────────────

    const validationErrors: string[] = [];

    // Validate invoice_id
    if (!body.invoice_id || !validateUUID(body.invoice_id)) {
      validationErrors.push("invoice_id is required and must be a valid UUID");
    }

    // Validate amount
    if (body.amount === null || body.amount === undefined || !validateAmount(body.amount)) {
      validationErrors.push("amount is required and must be a positive number (0.01 - 999,999,999.99)");
    }

    // Validate payment_method
    if (
      !body.payment_method ||
      !VALID_PAYMENT_METHODS.includes(body.payment_method as typeof VALID_PAYMENT_METHODS[number])
    ) {
      validationErrors.push(
        `payment_method is required and must be one of: ${VALID_PAYMENT_METHODS.join(", ")}`
      );
    }

    // Validate optional payment_date if provided
    if (body.payment_date && !isValidDate(body.payment_date)) {
      validationErrors.push("payment_date must be a valid date in YYYY-MM-DD format");
    }

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

    // ─── Verify invoice exists and belongs to tenant ────────────────────────────

    const { data: invoice, error: invoiceError } = await adminClient
      .from("transport_invoices")
      .select("id, tenant_id, amount, status, invoice_number, student_id, guardian_id")
      .eq("id", body.invoice_id)
      .eq("tenant_id", caller.tenant_id)
      .single();

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({
          error: "Invoice not found or does not belong to your tenant",
          code: "NOT_FOUND",
        } as ErrorResponse),
        { status: 404, headers }
      );
    }

    // ─── Insert payment record ──────────────────────────────────────────────────

    const paymentDate = body.payment_date || new Date().toISOString().split("T")[0];
    const reference = body.reference ? sanitizeInput(body.reference.trim()) : null;

    const { data: payment, error: paymentError } = await adminClient
      .from("transport_payments")
      .insert({
        tenant_id: caller.tenant_id,
        invoice_id: body.invoice_id,
        amount: body.amount,
        payment_method: body.payment_method,
        payment_date: paymentDate,
        reference,
      })
      .select("id")
      .single();

    if (paymentError || !payment) {
      return new Response(
        JSON.stringify({
          error: "Failed to record payment",
          code: "INTERNAL_ERROR",
          details: paymentError?.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    // ─── Calculate total payments and update invoice status ─────────────────────

    const { data: payments, error: paymentsError } = await adminClient
      .from("transport_payments")
      .select("amount")
      .eq("invoice_id", body.invoice_id);

    if (paymentsError) {
      console.error("[record-payment] Failed to sum payments:", paymentsError.message);
    }

    const totalPaid = (payments || []).reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );

    let invoiceStatus = invoice.status;

    if (totalPaid >= Number(invoice.amount)) {
      // Update invoice status to 'paid'
      const { error: updateError } = await adminClient
        .from("transport_invoices")
        .update({ status: "paid" })
        .eq("id", body.invoice_id)
        .eq("tenant_id", caller.tenant_id);

      if (updateError) {
        console.error("[record-payment] Failed to update invoice status:", updateError.message);
      } else {
        invoiceStatus = "paid";
      }
    }

    // ─── Log to audit log ───────────────────────────────────────────────────────

    await logAuditEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "payment_recorded",
      entity_type: "payment",
      entity_id: payment.id,
      details: {
        invoice_id: body.invoice_id,
        invoice_number: invoice.invoice_number,
        payment_amount: body.amount,
        payment_method: body.payment_method,
        payment_date: paymentDate,
        reference,
        total_paid: totalPaid,
        invoice_amount: invoice.amount,
        invoice_status: invoiceStatus,
        performed_by: caller.id,
      },
      ip_address: ip,
    });

    // ─── Return result ──────────────────────────────────────────────────────────

    return new Response(
      JSON.stringify({
        payment_id: payment.id,
        invoice_status: invoiceStatus,
      }),
      { status: 200, headers }
    );
  } catch (error) {
    // If verifyCallerRole threw a Response, return it with CORS headers
    if (error instanceof Response) {
      const body = await error.text();
      return new Response(body, { status: error.status, headers });
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[record-payment] Unhandled error:", message);
    return new Response(
      JSON.stringify({ error: message, code: "INTERNAL_ERROR" } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
