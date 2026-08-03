/**
 * Edge Function: check-vehicle-compliance
 *
 * Triggered by pg_cron daily (recommended: 06:00 SAST). Finds vehicles
 * across all tenants with compliance_certificate_expiry within the next
 * 30 days or already expired, generates operator alert notifications
 * and audit log entries.
 *
 * Auth: Service role (cron-invoked, no user auth needed).
 *       Validates the incoming request has a service role key or a
 *       CRON_SECRET for manual invocation.
 *
 * Flow:
 * 1. Validate service role key in Authorization header (or CRON_SECRET query param)
 * 2. Query all non-decommissioned vehicles with compliance_certificate_expiry
 *    between today and today + 30 days (expiring soon)
 * 3. Query all non-decommissioned vehicles with expired compliance certificates
 * 4. For each expiring vehicle, look up operators for the tenant and create
 *    audit log entries + notification records
 * 5. For already-expired vehicles, log warnings
 * 6. Return summary of vehicles checked and notifications generated
 *
 * Returns:
 * - 200 with summary of vehicles checked and alerts sent
 * - 401 on missing/invalid service role key
 * - 500 on internal errors
 *
 * Requirements: 3.3
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface ComplianceVehicle {
  id: string;
  tenant_id: string;
  registration_number: string;
  make: string;
  model: string;
  compliance_certificate_expiry: string;
  status: string;
}

interface OperatorUser {
  id: string;
  email: string;
  raw_user_meta_data: {
    tenant_id: string;
    role: string;
    display_name?: string;
  };
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
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(today.getDate() + 30);
    const thirtyDaysStr = thirtyDaysFromNow.toISOString().split("T")[0];

    console.log(
      `[check-vehicle-compliance] Running compliance check. Today: ${todayStr}, Window end: ${thirtyDaysStr}`
    );

    // --- Step 2: Query vehicles expiring within 30 days ---
    const { data: expiringVehicles, error: expiringError } = await supabase
      .from("transport_vehicles")
      .select(
        "id, tenant_id, registration_number, make, model, compliance_certificate_expiry, status"
      )
      .neq("status", "decommissioned")
      .gte("compliance_certificate_expiry", todayStr)
      .lte("compliance_certificate_expiry", thirtyDaysStr);

    if (expiringError) {
      console.error(
        "[check-vehicle-compliance] Failed to query expiring vehicles:",
        expiringError.message
      );
      return new Response(
        JSON.stringify({ error: "Failed to query expiring vehicles" }),
        { status: 500, headers: responseHeaders }
      );
    }

    // --- Step 3: Query already-expired vehicles ---
    const { data: expiredVehicles, error: expiredError } = await supabase
      .from("transport_vehicles")
      .select(
        "id, tenant_id, registration_number, make, model, compliance_certificate_expiry, status"
      )
      .neq("status", "decommissioned")
      .lt("compliance_certificate_expiry", todayStr);

    if (expiredError) {
      console.error(
        "[check-vehicle-compliance] Failed to query expired vehicles:",
        expiredError.message
      );
      return new Response(
        JSON.stringify({ error: "Failed to query expired vehicles" }),
        { status: 500, headers: responseHeaders }
      );
    }

    let alertsGenerated = 0;
    let expiredWarnings = 0;

    // --- Step 4: Process expiring vehicles (within 30 days) ---
    if (expiringVehicles && expiringVehicles.length > 0) {
      // Group vehicles by tenant for efficient operator lookups
      const vehiclesByTenant = new Map<string, ComplianceVehicle[]>();
      for (const vehicle of expiringVehicles as ComplianceVehicle[]) {
        const existing = vehiclesByTenant.get(vehicle.tenant_id) || [];
        existing.push(vehicle);
        vehiclesByTenant.set(vehicle.tenant_id, existing);
      }

      for (const [tenantId, vehicles] of vehiclesByTenant) {
        // Look up operators for this tenant
        const { data: operators, error: opsError } = await supabase
          .from("users")
          .select("id, email, raw_user_meta_data")
          .eq("raw_user_meta_data->>tenant_id", tenantId)
          .in("raw_user_meta_data->>role", ["operator", "admin"]);

        if (opsError) {
          console.warn(
            `[check-vehicle-compliance] Failed to query operators for tenant ${tenantId}:`,
            opsError.message
          );
          // Fall back to logging audit entries without operator-specific notification
        }

        for (const vehicle of vehicles) {
          const daysUntilExpiry = Math.ceil(
            (new Date(vehicle.compliance_certificate_expiry).getTime() -
              today.getTime()) /
              (1000 * 60 * 60 * 24)
          );

          // Log audit entry for compliance expiry warning
          await supabase.from("transport_audit_log").insert({
            tenant_id: tenantId,
            user_id: null, // system-generated
            event_type: "compliance_expiry_warning",
            entity_type: "vehicle",
            entity_id: vehicle.id,
            details: {
              registration_number: vehicle.registration_number,
              make: vehicle.make,
              model: vehicle.model,
              compliance_certificate_expiry:
                vehicle.compliance_certificate_expiry,
              days_until_expiry: daysUntilExpiry,
            },
            ip_address: null,
          });

          alertsGenerated++;

          console.log(
            `[check-vehicle-compliance] Alert: Vehicle ${vehicle.registration_number} ` +
              `(${vehicle.make} ${vehicle.model}) expires in ${daysUntilExpiry} days ` +
              `(tenant: ${tenantId})`
          );
        }

        // Notify operators via audit log entry at tenant level
        if (operators && operators.length > 0) {
          for (const operator of operators as OperatorUser[]) {
            await supabase.from("transport_audit_log").insert({
              tenant_id: tenantId,
              user_id: operator.id,
              event_type: "compliance_expiry_operator_alert",
              entity_type: "vehicle",
              entity_id: null,
              details: {
                vehicles_expiring: vehicles.map((v) => ({
                  id: v.id,
                  registration_number: v.registration_number,
                  compliance_certificate_expiry:
                    v.compliance_certificate_expiry,
                  days_until_expiry: Math.ceil(
                    (new Date(v.compliance_certificate_expiry).getTime() -
                      today.getTime()) /
                      (1000 * 60 * 60 * 24)
                  ),
                })),
                operator_email: operator.email,
                alert_type: "compliance_expiry_warning",
              },
              ip_address: null,
            });
          }
        }
      }
    }

    // --- Step 5: Log warnings for already-expired vehicles ---
    if (expiredVehicles && expiredVehicles.length > 0) {
      for (const vehicle of expiredVehicles as ComplianceVehicle[]) {
        const daysSinceExpiry = Math.ceil(
          (today.getTime() -
            new Date(vehicle.compliance_certificate_expiry).getTime()) /
            (1000 * 60 * 60 * 24)
        );

        await supabase.from("transport_audit_log").insert({
          tenant_id: vehicle.tenant_id,
          user_id: null,
          event_type: "compliance_expired",
          entity_type: "vehicle",
          entity_id: vehicle.id,
          details: {
            registration_number: vehicle.registration_number,
            make: vehicle.make,
            model: vehicle.model,
            compliance_certificate_expiry:
              vehicle.compliance_certificate_expiry,
            days_since_expiry: daysSinceExpiry,
            warning:
              "Vehicle compliance certificate has expired. Vehicle should not be assigned to active routes.",
          },
          ip_address: null,
        });

        expiredWarnings++;

        console.warn(
          `[check-vehicle-compliance] EXPIRED: Vehicle ${vehicle.registration_number} ` +
            `(${vehicle.make} ${vehicle.model}) expired ${daysSinceExpiry} days ago ` +
            `(tenant: ${vehicle.tenant_id})`
        );
      }
    }

    // --- Step 6: Return summary ---
    const summary = {
      success: true,
      checked_at: today.toISOString(),
      expiring_vehicles: expiringVehicles?.length || 0,
      expired_vehicles: expiredVehicles?.length || 0,
      alerts_generated: alertsGenerated,
      expired_warnings: expiredWarnings,
    };

    console.log(
      `[check-vehicle-compliance] Complete: ${summary.expiring_vehicles} expiring, ` +
        `${summary.expired_vehicles} expired, ${summary.alerts_generated} alerts generated`
    );

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    console.error("[check-vehicle-compliance] Unhandled error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: responseHeaders,
    });
  }
});
