/**
 * Edge Function: generate-invoice (Transport Billing)
 *
 * Generates monthly invoices for all active students with assigned routes.
 * Skips students who already have an invoice for the billing month.
 * Queues notification to guardian via preferred channel (including WhatsApp with payment link).
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * POST body:
 * {
 *   billing_month?: string  // Format YYYY-MM-DD (first of month). Defaults to current month.
 * }
 *
 * Returns:
 * {
 *   invoices_generated: number,
 *   total_amount: number,
 *   skipped: number
 * }
 *
 * Requirements: 10.1, 10.2, 10.3, 15.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GenerateInvoiceRequest {
  billing_month?: string;
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

// ─── Helper: Get billing month (first of month, YYYY-MM-DD) ────────────────────

function resolveBillingMonth(input?: string): { valid: boolean; value: string; error?: string } {
  if (!input) {
    // Default to first of current month
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return { valid: true, value: `${year}-${month}-01` };
  }

  // Validate format YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(input)) {
    return { valid: false, value: "", error: "billing_month must be in YYYY-MM-DD format" };
  }

  const parsed = new Date(input + "T00:00:00Z");
  if (isNaN(parsed.getTime())) {
    return { valid: false, value: "", error: "billing_month must be a valid date" };
  }

  // Ensure it's the first of the month
  const day = parseInt(input.split("-")[2], 10);
  if (day !== 1) {
    return { valid: false, value: "", error: "billing_month must be the first of a month (day = 01)" };
  }

  return { valid: true, value: input };
}

// ─── Helper: Generate invoice number ───────────────────────────────────────────

function generateInvoiceNumber(tenantPrefix: string, billingMonth: string, sequence: number): string {
  // Format: {tenant_prefix}-{YYYYMM}-{sequence}
  const [year, month] = billingMonth.split("-");
  const seq = String(sequence).padStart(4, "0");
  return `${tenantPrefix}-${year}${month}-${seq}`;
}

// ─── Helper: Calculate due date (billing_month + 30 days) ──────────────────────

function calculateDueDate(billingMonth: string): string {
  const date = new Date(billingMonth + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().split("T")[0];
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
    console.error("[generate-invoice][audit] Failed to log event:", error.message);
  }
}

// ─── Helper: Queue notification to guardian ────────────────────────────────────

async function queueInvoiceNotification(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    guardian_id: string;
    guardian_channel: string;
    student_name: string;
    invoice_number: string;
    amount: number;
    due_date: string;
  }
): Promise<void> {
  const templateParams: Record<string, string> = {
    student_name: params.student_name,
    invoice_number: params.invoice_number,
    amount: params.amount.toFixed(2),
    due_date: params.due_date,
    payment_link: `https://pay.phoenix-transport.co.za/invoice/${params.invoice_number}`,
  };

  const { error } = await adminClient.from("transport_notifications").insert({
    tenant_id: params.tenant_id,
    guardian_id: params.guardian_id,
    notification_type: "invoice",
    channel: params.guardian_channel,
    template_name: params.guardian_channel === "whatsapp" ? "invoice_payment" : "invoice_generated",
    template_params: templateParams,
    delivery_status: "pending",
  });

  if (error) {
    console.error("[generate-invoice][notification] Failed to queue notification:", error.message);
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
    let body: GenerateInvoiceRequest = {};
    try {
      const text = await req.text();
      if (text.trim()) {
        body = JSON.parse(text);
      }
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Resolve and validate billing month
    const billingMonthResult = resolveBillingMonth(body.billing_month);
    if (!billingMonthResult.valid) {
      return new Response(
        JSON.stringify({
          error: billingMonthResult.error,
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const billingMonth = billingMonthResult.value;
    const dueDate = calculateDueDate(billingMonth);

    const adminClient = getAdminClient();

    // Fetch tenant info for invoice number prefix
    const { data: tenant, error: tenantError } = await adminClient
      .from("tenants")
      .select("id, name")
      .eq("id", caller.tenant_id)
      .single();

    if (tenantError || !tenant) {
      return new Response(
        JSON.stringify({
          error: "Tenant not found",
          code: "NOT_FOUND",
        } as ErrorResponse),
        { status: 404, headers }
      );
    }

    // Generate tenant prefix (first 3 chars uppercase of tenant name, or fallback)
    const tenantPrefix = (tenant.name || "TNT")
      .replace(/[^a-zA-Z]/g, "")
      .substring(0, 3)
      .toUpperCase() || "TNT";

    // Fetch all active students with assigned routes for this tenant
    const { data: students, error: studentsError } = await adminClient
      .from("transport_students")
      .select(`
        id,
        full_name,
        assigned_route_id,
        transport_routes!inner (
          id,
          monthly_fee
        )
      `)
      .eq("tenant_id", caller.tenant_id)
      .eq("status", "active")
      .not("assigned_route_id", "is", null);

    if (studentsError) {
      return new Response(
        JSON.stringify({
          error: "Failed to fetch students",
          code: "INTERNAL_ERROR",
          details: studentsError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    if (!students || students.length === 0) {
      return new Response(
        JSON.stringify({
          invoices_generated: 0,
          total_amount: 0,
          skipped: 0,
        }),
        { status: 200, headers }
      );
    }

    // Fetch existing invoices for this billing month to avoid duplicates
    const { data: existingInvoices, error: existingError } = await adminClient
      .from("transport_invoices")
      .select("student_id")
      .eq("tenant_id", caller.tenant_id)
      .eq("billing_month", billingMonth);

    if (existingError) {
      return new Response(
        JSON.stringify({
          error: "Failed to check existing invoices",
          code: "INTERNAL_ERROR",
          details: existingError.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    const existingStudentIds = new Set(
      (existingInvoices || []).map((inv) => inv.student_id)
    );

    // Get existing invoice count for sequence numbering
    const { count: existingCount, error: countError } = await adminClient
      .from("transport_invoices")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", caller.tenant_id)
      .like("invoice_number", `${tenantPrefix}-${billingMonth.substring(0, 4)}${billingMonth.substring(5, 7)}-%`);

    if (countError) {
      console.error("[generate-invoice] Failed to get invoice count:", countError.message);
    }

    let sequence = (existingCount || 0) + 1;

    // Process each student
    let invoicesGenerated = 0;
    let totalAmount = 0;
    let skipped = 0;

    for (const student of students) {
      // Skip students who already have an invoice for this billing month
      if (existingStudentIds.has(student.id)) {
        skipped++;
        continue;
      }

      // Get route monthly fee
      const route = student.transport_routes as unknown as { id: string; monthly_fee: number };
      if (!route || !route.monthly_fee || route.monthly_fee <= 0) {
        skipped++;
        continue;
      }

      const amount = Number(route.monthly_fee);

      // Get primary guardian for this student
      const { data: guardianLink, error: guardianError } = await adminClient
        .from("transport_student_guardians")
        .select(`
          guardian_id,
          is_primary,
          transport_guardians!inner (
            id,
            full_name,
            preferred_notification_channel
          )
        `)
        .eq("student_id", student.id)
        .order("is_primary", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (guardianError || !guardianLink) {
        // Skip students without a linked guardian
        skipped++;
        continue;
      }

      const guardian = guardianLink.transport_guardians as unknown as {
        id: string;
        full_name: string;
        preferred_notification_channel: string;
      };

      // Generate invoice number
      const invoiceNumber = generateInvoiceNumber(tenantPrefix, billingMonth, sequence);
      sequence++;

      // Insert invoice record
      const { data: invoice, error: invoiceError } = await adminClient
        .from("transport_invoices")
        .insert({
          tenant_id: caller.tenant_id,
          student_id: student.id,
          guardian_id: guardian.id,
          invoice_number: invoiceNumber,
          billing_month: billingMonth,
          amount,
          status: "pending",
          due_date: dueDate,
        })
        .select("id, invoice_number")
        .single();

      if (invoiceError) {
        console.error(
          `[generate-invoice] Failed to create invoice for student ${student.id}:`,
          invoiceError.message
        );
        skipped++;
        continue;
      }

      invoicesGenerated++;
      totalAmount += amount;

      // Queue notification to guardian via preferred channel
      await queueInvoiceNotification(adminClient, {
        tenant_id: caller.tenant_id,
        guardian_id: guardian.id,
        guardian_channel: guardian.preferred_notification_channel || "sms",
        student_name: student.full_name,
        invoice_number: invoice.invoice_number,
        amount,
        due_date: dueDate,
      });
    }

    // Log audit event for batch invoice generation
    await logAuditEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "invoices_generated",
      entity_type: "invoice",
      entity_id: null,
      details: {
        billing_month: billingMonth,
        invoices_generated: invoicesGenerated,
        total_amount: totalAmount,
        skipped,
        due_date: dueDate,
      },
      ip_address: ip,
    });

    return new Response(
      JSON.stringify({
        invoices_generated: invoicesGenerated,
        total_amount: totalAmount,
        skipped,
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
    console.error("[generate-invoice] Unhandled error:", message);
    return new Response(
      JSON.stringify({ error: message, code: "INTERNAL_ERROR" } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
