/**
 * Edge Function: check-overdue-invoices
 *
 * Triggered by pg_cron daily (recommended: 07:00 SAST). Monitors overdue
 * invoices across all tenants and takes appropriate action based on
 * how far past due the invoices are.
 *
 * Auth: Service role (cron-invoked, no user auth needed).
 *       Validates the incoming request has a service role key or a
 *       CRON_SECRET for manual invocation.
 *
 * Flow:
 * 1. Validate service role key in Authorization header (or CRON_SECRET query param)
 * 2. Update invoice status to 'overdue' for invoices past due_date that are still 'pending'
 * 3. Find invoices with status='pending' and due_date + 14 days < today → send payment
 *    reminder to guardian
 * 4. Find invoices with status='pending' or 'overdue' and due_date + 30 days < today →
 *    flag student account (set status='suspended') and notify operator
 * 5. Return summary
 *
 * Returns:
 * - 200 with summary of invoices processed
 * - 401 on missing/invalid service role key
 * - 500 on internal errors
 *
 * Requirements: 10.5, 10.6
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface OverdueInvoice {
  id: string;
  tenant_id: string;
  student_id: string;
  guardian_id: string;
  invoice_number: string;
  billing_month: string;
  amount: number;
  status: string;
  due_date: string;
}

Deno.serve(async (req: Request) => {
  const responseHeaders = {
    "Content-Type": "application/json",
  };

  try {
    // --- Step 1: Validate service role key ---
    const authHeader = req.headers.get("Authorization");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const cronSecret = Deno.env.get("CRON_SECRET");

    // Allow auth via service role key in Authorization header
    const hasValidServiceKey =
      authHeader &&
      authHeader.startsWith("Bearer ") &&
      authHeader.replace("Bearer ", "") === serviceRoleKey;

    // Allow auth via CRON_SECRET for manual invocation
    const url = new URL(req.url);
    const hasValidCronSecret =
      cronSecret && url.searchParams.get("secret") === cronSecret;

    if (!hasValidServiceKey && !hasValidCronSecret) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: invalid service role key" }),
        { status: 401, headers: responseHeaders }
      );
    }

    // --- Create Supabase client with service role (bypasses RLS) ---
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0]; // YYYY-MM-DD

    // Calculate threshold dates
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(today.getDate() - 14);
    const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().split("T")[0];

    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    console.log(
      `[check-overdue-invoices] Running overdue check. Today: ${todayStr}, ` +
        `14-day threshold: ${fourteenDaysAgoStr}, 30-day threshold: ${thirtyDaysAgoStr}`
    );

    let statusUpdated = 0;
    let remindersSent = 0;
    let accountsFlagged = 0;
    let operatorNotifications = 0;

    // --- Step 2: Update invoice status to 'overdue' for pending invoices past due_date ---
    const { data: pendingPastDue, error: pendingError } = await supabase
      .from("transport_invoices")
      .select("id")
      .eq("status", "pending")
      .lt("due_date", todayStr);

    if (pendingError) {
      console.error(
        "[check-overdue-invoices] Failed to query pending past-due invoices:",
        pendingError.message
      );
      return new Response(
        JSON.stringify({ error: "Failed to query pending past-due invoices" }),
        { status: 500, headers: responseHeaders }
      );
    }

    if (pendingPastDue && pendingPastDue.length > 0) {
      const pendingIds = pendingPastDue.map((inv) => inv.id);
      const { error: updateError } = await supabase
        .from("transport_invoices")
        .update({ status: "overdue" })
        .in("id", pendingIds);

      if (updateError) {
        console.error(
          "[check-overdue-invoices] Failed to update invoice statuses:",
          updateError.message
        );
      } else {
        statusUpdated = pendingIds.length;
        console.log(
          `[check-overdue-invoices] Updated ${statusUpdated} invoices from 'pending' to 'overdue'`
        );
      }
    }

    // --- Step 3: Send payment reminder for invoices 14+ days overdue ---
    // Find invoices where due_date + 14 days < today (i.e. due_date < fourteenDaysAgoStr)
    // and status is 'pending' or 'overdue' (pending ones were just changed to overdue above)
    const { data: reminderInvoices, error: reminderError } = await supabase
      .from("transport_invoices")
      .select(
        "id, tenant_id, student_id, guardian_id, invoice_number, billing_month, amount, status, due_date"
      )
      .in("status", ["pending", "overdue"])
      .lt("due_date", fourteenDaysAgoStr);

    if (reminderError) {
      console.error(
        "[check-overdue-invoices] Failed to query 14-day overdue invoices:",
        reminderError.message
      );
      return new Response(
        JSON.stringify({ error: "Failed to query 14-day overdue invoices" }),
        { status: 500, headers: responseHeaders }
      );
    }

    if (reminderInvoices && reminderInvoices.length > 0) {
      for (const invoice of reminderInvoices as OverdueInvoice[]) {
        // Send payment reminder notification to guardian
        const { error: notifError } = await supabase
          .from("transport_notifications")
          .insert({
            tenant_id: invoice.tenant_id,
            guardian_id: invoice.guardian_id,
            notification_type: "payment_reminder",
            channel: "sms", // Will be routed via preferred channel by send-notification
            template_name: "payment_reminder",
            template_params: {
              invoice_number: invoice.invoice_number,
              amount: invoice.amount.toString(),
              due_date: invoice.due_date,
              student_id: invoice.student_id,
            },
            delivery_status: "pending",
            retry_count: 0,
            fallback_used: false,
          });

        if (notifError) {
          console.warn(
            `[check-overdue-invoices] Failed to create reminder notification for invoice ${invoice.invoice_number}:`,
            notifError.message
          );
        } else {
          remindersSent++;
        }

        // Log audit entry
        await supabase.from("transport_audit_log").insert({
          tenant_id: invoice.tenant_id,
          user_id: null,
          event_type: "payment_reminder_sent",
          entity_type: "invoice",
          entity_id: invoice.id,
          details: {
            invoice_number: invoice.invoice_number,
            amount: invoice.amount,
            due_date: invoice.due_date,
            days_overdue: Math.ceil(
              (today.getTime() - new Date(invoice.due_date).getTime()) /
                (1000 * 60 * 60 * 24)
            ),
            guardian_id: invoice.guardian_id,
          },
          ip_address: null,
        });

        console.log(
          `[check-overdue-invoices] Payment reminder sent for invoice ${invoice.invoice_number} ` +
            `(tenant: ${invoice.tenant_id}, guardian: ${invoice.guardian_id})`
        );
      }
    }

    // --- Step 4: Flag student accounts for invoices 30+ days overdue ---
    // Find invoices where due_date + 30 days < today (i.e. due_date < thirtyDaysAgoStr)
    const { data: flagInvoices, error: flagError } = await supabase
      .from("transport_invoices")
      .select(
        "id, tenant_id, student_id, guardian_id, invoice_number, billing_month, amount, status, due_date"
      )
      .in("status", ["pending", "overdue"])
      .lt("due_date", thirtyDaysAgoStr);

    if (flagError) {
      console.error(
        "[check-overdue-invoices] Failed to query 30-day overdue invoices:",
        flagError.message
      );
      return new Response(
        JSON.stringify({ error: "Failed to query 30-day overdue invoices" }),
        { status: 500, headers: responseHeaders }
      );
    }

    if (flagInvoices && flagInvoices.length > 0) {
      // Deduplicate students (one student may have multiple overdue invoices)
      const studentTenantMap = new Map<string, { tenant_id: string; invoices: OverdueInvoice[] }>();

      for (const invoice of flagInvoices as OverdueInvoice[]) {
        const key = `${invoice.tenant_id}:${invoice.student_id}`;
        const existing = studentTenantMap.get(key);
        if (existing) {
          existing.invoices.push(invoice);
        } else {
          studentTenantMap.set(key, {
            tenant_id: invoice.tenant_id,
            invoices: [invoice],
          });
        }
      }

      for (const [key, { tenant_id, invoices }] of studentTenantMap) {
        const studentId = key.split(":")[1];

        // Flag student account by setting status to 'suspended'
        const { error: suspendError } = await supabase
          .from("transport_students")
          .update({ status: "suspended", updated_at: new Date().toISOString() })
          .eq("id", studentId)
          .eq("status", "active"); // Only suspend if currently active

        if (suspendError) {
          console.warn(
            `[check-overdue-invoices] Failed to suspend student ${studentId}:`,
            suspendError.message
          );
        } else {
          accountsFlagged++;
        }

        // Notify operators for this tenant
        const { data: operators, error: opsError } = await supabase
          .from("users")
          .select("id, email, raw_user_meta_data")
          .eq("raw_user_meta_data->>tenant_id", tenant_id)
          .in("raw_user_meta_data->>role", ["operator", "admin"]);

        if (opsError) {
          console.warn(
            `[check-overdue-invoices] Failed to query operators for tenant ${tenant_id}:`,
            opsError.message
          );
        }

        // Log audit entry for account suspension
        await supabase.from("transport_audit_log").insert({
          tenant_id,
          user_id: null,
          event_type: "student_account_suspended",
          entity_type: "student",
          entity_id: studentId,
          details: {
            reason: "invoices_overdue_30_days",
            overdue_invoices: invoices.map((inv) => ({
              id: inv.id,
              invoice_number: inv.invoice_number,
              amount: inv.amount,
              due_date: inv.due_date,
              days_overdue: Math.ceil(
                (today.getTime() - new Date(inv.due_date).getTime()) /
                  (1000 * 60 * 60 * 24)
              ),
            })),
          },
          ip_address: null,
        });

        // Notify each operator
        if (operators && operators.length > 0) {
          for (const operator of operators) {
            await supabase.from("transport_audit_log").insert({
              tenant_id,
              user_id: operator.id,
              event_type: "overdue_invoice_operator_alert",
              entity_type: "student",
              entity_id: studentId,
              details: {
                alert_type: "student_suspended_overdue",
                student_id: studentId,
                overdue_invoices: invoices.map((inv) => ({
                  invoice_number: inv.invoice_number,
                  amount: inv.amount,
                  due_date: inv.due_date,
                })),
                operator_email: operator.email,
              },
              ip_address: null,
            });

            operatorNotifications++;
          }
        }

        console.log(
          `[check-overdue-invoices] Student ${studentId} suspended due to ${invoices.length} ` +
            `invoice(s) overdue 30+ days (tenant: ${tenant_id})`
        );
      }
    }

    // --- Step 5: Return summary ---
    const summary = {
      success: true,
      checked_at: today.toISOString(),
      invoices_marked_overdue: statusUpdated,
      payment_reminders_sent: remindersSent,
      student_accounts_flagged: accountsFlagged,
      operator_notifications_sent: operatorNotifications,
      total_14_day_overdue: reminderInvoices?.length || 0,
      total_30_day_overdue: flagInvoices?.length || 0,
    };

    console.log(
      `[check-overdue-invoices] Complete: ${summary.invoices_marked_overdue} marked overdue, ` +
        `${summary.payment_reminders_sent} reminders sent, ` +
        `${summary.student_accounts_flagged} accounts flagged, ` +
        `${summary.operator_notifications_sent} operator notifications`
    );

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    console.error("[check-overdue-invoices] Unhandled error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: responseHeaders,
    });
  }
});
