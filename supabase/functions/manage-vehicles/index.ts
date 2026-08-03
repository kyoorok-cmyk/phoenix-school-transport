/**
 * Edge Function: manage-vehicles
 *
 * CRUD operations for transport vehicles with compliance checks.
 *
 * Endpoints:
 *   GET    - List all vehicles for the tenant (with assignment and compliance status)
 *   POST   - Create a new vehicle (validate: registration_number, make, model, year, seating_capacity, compliance_certificate_expiry)
 *   PUT    - Update a vehicle (block assignment if compliance is expired)
 *   DELETE - Delete a vehicle (block if assigned to in-progress trip)
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * All vehicle modifications are logged to transport_audit_log.
 *
 * Requirements: 3.1, 3.4, 3.5, 14.2
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { sanitizeInput, validateRequired, validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateVehicleRequest {
  registration_number: string;
  make: string;
  model: string;
  year: number;
  seating_capacity: number;
  compliance_certificate_expiry: string; // ISO date string YYYY-MM-DD
}

interface UpdateVehicleRequest {
  id: string;
  registration_number?: string;
  make?: string;
  model?: string;
  year?: number;
  seating_capacity?: number;
  compliance_certificate_expiry?: string;
  status?: "available" | "assigned" | "maintenance" | "decommissioned";
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
const VALID_STATUSES = ["available", "assigned", "maintenance", "decommissioned"] as const;
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const MIN_SEATING_CAPACITY = 1;
const MAX_SEATING_CAPACITY = 100;

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
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// ─── Helper: Log vehicle event to transport_audit_log ──────────────────────────

async function logVehicleEvent(
  adminClient: ReturnType<typeof createClient>,
  params: {
    tenant_id: string;
    user_id: string;
    event_type: string;
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
    entity_type: "vehicle",
    entity_id: params.entity_id,
    details: params.details,
    ip_address: safeIp,
  });

  if (error) {
    console.error("[manage-vehicles][audit] Failed to log event:", error.message, params);
  }
}

// ─── Helper: Check if compliance certificate is expired ────────────────────────

function isComplianceExpired(expiryDateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDateStr);
  expiry.setHours(0, 0, 0, 0);
  return expiry < today;
}

// ─── Helper: Validate date format (YYYY-MM-DD) ────────────────────────────────

function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

// ─── Handler: GET - List vehicles ──────────────────────────────────────────────

async function handleListVehicles(
  _req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const adminClient = getAdminClient();

  const { data: vehicles, error } = await adminClient
    .from("transport_vehicles")
    .select("*")
    .eq("tenant_id", caller.tenant_id)
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch vehicles",
        code: "INTERNAL_ERROR",
        details: error.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Enrich each vehicle with compliance status
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const enrichedVehicles = (vehicles || []).map((v) => {
    const expiry = new Date(v.compliance_certificate_expiry);
    expiry.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.ceil(
      (expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );

    let compliance_status: "valid" | "expiring_soon" | "expired";
    if (daysUntilExpiry < 0) {
      compliance_status = "expired";
    } else if (daysUntilExpiry <= 30) {
      compliance_status = "expiring_soon";
    } else {
      compliance_status = "valid";
    }

    return {
      ...v,
      compliance_status,
      days_until_expiry: daysUntilExpiry,
    };
  });

  return new Response(
    JSON.stringify({
      vehicles: enrichedVehicles,
      total: enrichedVehicles.length,
    }),
    { status: 200, headers }
  );
}

// ─── Handler: POST - Create vehicle ────────────────────────────────────────────

async function handleCreateVehicle(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  let body: CreateVehicleRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON body",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const ip = extractIp(req);

  // Validate required fields
  const { valid, missing } = validateRequired(
    {
      registration_number: body.registration_number,
      make: body.make,
      model: body.model,
      year: body.year,
      seating_capacity: body.seating_capacity,
      compliance_certificate_expiry: body.compliance_certificate_expiry,
    },
    ["registration_number", "make", "model", "year", "seating_capacity", "compliance_certificate_expiry"]
  );

  if (!valid) {
    return new Response(
      JSON.stringify({
        error: "Validation failed: missing required fields",
        code: "VALIDATION_ERROR",
        details: missing.map((f) => `${f} is required`),
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate year range
  if (typeof body.year !== "number" || body.year < MIN_YEAR || body.year > MAX_YEAR) {
    return new Response(
      JSON.stringify({
        error: `year must be between ${MIN_YEAR} and ${MAX_YEAR}`,
        code: "VALIDATION_ERROR",
        details: { field: "year", min: MIN_YEAR, max: MAX_YEAR, received: body.year },
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate seating capacity
  if (
    typeof body.seating_capacity !== "number" ||
    body.seating_capacity < MIN_SEATING_CAPACITY ||
    body.seating_capacity > MAX_SEATING_CAPACITY ||
    !Number.isInteger(body.seating_capacity)
  ) {
    return new Response(
      JSON.stringify({
        error: `seating_capacity must be an integer between ${MIN_SEATING_CAPACITY} and ${MAX_SEATING_CAPACITY}`,
        code: "VALIDATION_ERROR",
        details: { field: "seating_capacity", min: MIN_SEATING_CAPACITY, max: MAX_SEATING_CAPACITY, received: body.seating_capacity },
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate compliance_certificate_expiry date format
  if (!isValidDate(body.compliance_certificate_expiry)) {
    return new Response(
      JSON.stringify({
        error: "compliance_certificate_expiry must be a valid date in YYYY-MM-DD format",
        code: "VALIDATION_ERROR",
        details: { field: "compliance_certificate_expiry", received: body.compliance_certificate_expiry },
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Sanitize string inputs
  const registrationNumber = sanitizeInput(body.registration_number.trim().toUpperCase());
  const make = sanitizeInput(body.make.trim());
  const model = sanitizeInput(body.model.trim());

  const adminClient = getAdminClient();

  // Check registration_number uniqueness within tenant
  const { data: existing, error: checkError } = await adminClient
    .from("transport_vehicles")
    .select("id")
    .eq("tenant_id", caller.tenant_id)
    .eq("registration_number", registrationNumber)
    .maybeSingle();

  if (checkError) {
    return new Response(
      JSON.stringify({
        error: "Failed to check registration number uniqueness",
        code: "INTERNAL_ERROR",
        details: checkError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  if (existing) {
    return new Response(
      JSON.stringify({
        error: "A vehicle with this registration number already exists for your tenant",
        code: "VALIDATION_ERROR",
        details: { field: "registration_number", value: registrationNumber },
      } as ErrorResponse),
      { status: 409, headers }
    );
  }

  // Insert vehicle
  const { data: vehicle, error: insertError } = await adminClient
    .from("transport_vehicles")
    .insert({
      tenant_id: caller.tenant_id,
      registration_number: registrationNumber,
      make,
      model,
      year: body.year,
      seating_capacity: body.seating_capacity,
      compliance_certificate_expiry: body.compliance_certificate_expiry,
      status: "available",
    })
    .select()
    .single();

  if (insertError) {
    return new Response(
      JSON.stringify({
        error: "Failed to create vehicle",
        code: "INTERNAL_ERROR",
        details: insertError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log vehicle creation to audit log
  await logVehicleEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "vehicle_created",
    entity_id: vehicle.id,
    details: {
      registration_number: registrationNumber,
      make,
      model,
      year: body.year,
      seating_capacity: body.seating_capacity,
      compliance_certificate_expiry: body.compliance_certificate_expiry,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Vehicle created successfully",
      vehicle,
    }),
    { status: 201, headers }
  );
}

// ─── Handler: PUT - Update vehicle ─────────────────────────────────────────────

async function handleUpdateVehicle(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  let body: UpdateVehicleRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Invalid JSON body",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const ip = extractIp(req);

  // Validate vehicle ID
  if (!body.id || !validateUUID(body.id)) {
    return new Response(
      JSON.stringify({
        error: "id is required and must be a valid UUID",
        code: "VALIDATION_ERROR",
        details: { field: "id" },
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Fetch existing vehicle
  const { data: existingVehicle, error: fetchError } = await adminClient
    .from("transport_vehicles")
    .select("*")
    .eq("id", body.id)
    .eq("tenant_id", caller.tenant_id)
    .maybeSingle();

  if (fetchError) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch vehicle",
        code: "INTERNAL_ERROR",
        details: fetchError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  if (!existingVehicle) {
    return new Response(
      JSON.stringify({
        error: "Vehicle not found",
        code: "NOT_FOUND",
      } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Validate and apply optional fields
  if (body.registration_number !== undefined) {
    const regNum = sanitizeInput(body.registration_number.trim().toUpperCase());
    // Check uniqueness if changed
    if (regNum !== existingVehicle.registration_number) {
      const { data: duplicate } = await adminClient
        .from("transport_vehicles")
        .select("id")
        .eq("tenant_id", caller.tenant_id)
        .eq("registration_number", regNum)
        .neq("id", body.id)
        .maybeSingle();

      if (duplicate) {
        return new Response(
          JSON.stringify({
            error: "A vehicle with this registration number already exists for your tenant",
            code: "VALIDATION_ERROR",
            details: { field: "registration_number", value: regNum },
          } as ErrorResponse),
          { status: 409, headers }
        );
      }
    }
    updatePayload.registration_number = regNum;
  }

  if (body.make !== undefined) {
    updatePayload.make = sanitizeInput(body.make.trim());
  }

  if (body.model !== undefined) {
    updatePayload.model = sanitizeInput(body.model.trim());
  }

  if (body.year !== undefined) {
    if (typeof body.year !== "number" || body.year < MIN_YEAR || body.year > MAX_YEAR) {
      return new Response(
        JSON.stringify({
          error: `year must be between ${MIN_YEAR} and ${MAX_YEAR}`,
          code: "VALIDATION_ERROR",
          details: { field: "year", min: MIN_YEAR, max: MAX_YEAR, received: body.year },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updatePayload.year = body.year;
  }

  if (body.seating_capacity !== undefined) {
    if (
      typeof body.seating_capacity !== "number" ||
      body.seating_capacity < MIN_SEATING_CAPACITY ||
      body.seating_capacity > MAX_SEATING_CAPACITY ||
      !Number.isInteger(body.seating_capacity)
    ) {
      return new Response(
        JSON.stringify({
          error: `seating_capacity must be an integer between ${MIN_SEATING_CAPACITY} and ${MAX_SEATING_CAPACITY}`,
          code: "VALIDATION_ERROR",
          details: { field: "seating_capacity", min: MIN_SEATING_CAPACITY, max: MAX_SEATING_CAPACITY, received: body.seating_capacity },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updatePayload.seating_capacity = body.seating_capacity;
  }

  if (body.compliance_certificate_expiry !== undefined) {
    if (!isValidDate(body.compliance_certificate_expiry)) {
      return new Response(
        JSON.stringify({
          error: "compliance_certificate_expiry must be a valid date in YYYY-MM-DD format",
          code: "VALIDATION_ERROR",
          details: { field: "compliance_certificate_expiry", received: body.compliance_certificate_expiry },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    updatePayload.compliance_certificate_expiry = body.compliance_certificate_expiry;
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
      return new Response(
        JSON.stringify({
          error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          code: "VALIDATION_ERROR",
          details: { field: "status", valid_values: [...VALID_STATUSES], received: body.status },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Block assignment if compliance certificate is expired (Property 4)
    if (body.status === "assigned") {
      const expiryToCheck =
        (updatePayload.compliance_certificate_expiry as string) ||
        existingVehicle.compliance_certificate_expiry;

      if (isComplianceExpired(expiryToCheck)) {
        return new Response(
          JSON.stringify({
            error: "Cannot assign vehicle with expired compliance certificate",
            code: "VEHICLE_EXPIRED",
            details: {
              compliance_certificate_expiry: expiryToCheck,
              message: "Update the compliance certificate before assigning this vehicle",
            },
          } as ErrorResponse),
          { status: 403, headers }
        );
      }
    }

    updatePayload.status = body.status;
  }

  // Perform update
  const { data: updatedVehicle, error: updateError } = await adminClient
    .from("transport_vehicles")
    .update(updatePayload)
    .eq("id", body.id)
    .eq("tenant_id", caller.tenant_id)
    .select()
    .single();

  if (updateError) {
    return new Response(
      JSON.stringify({
        error: "Failed to update vehicle",
        code: "INTERNAL_ERROR",
        details: updateError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log vehicle update to audit log
  await logVehicleEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "vehicle_updated",
    entity_id: body.id,
    details: {
      changes: updatePayload,
      previous_values: {
        registration_number: existingVehicle.registration_number,
        make: existingVehicle.make,
        model: existingVehicle.model,
        year: existingVehicle.year,
        seating_capacity: existingVehicle.seating_capacity,
        compliance_certificate_expiry: existingVehicle.compliance_certificate_expiry,
        status: existingVehicle.status,
      },
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Vehicle updated successfully",
      vehicle: updatedVehicle,
    }),
    { status: 200, headers }
  );
}

// ─── Handler: DELETE - Delete vehicle ──────────────────────────────────────────

async function handleDeleteVehicle(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const ip = extractIp(req);

  // Extract vehicle ID from URL search params or body
  const url = new URL(req.url);
  let vehicleId = url.searchParams.get("id");

  if (!vehicleId) {
    try {
      const body = await req.json();
      vehicleId = body.id;
    } catch {
      // No body provided, id is missing
    }
  }

  if (!vehicleId || !validateUUID(vehicleId)) {
    return new Response(
      JSON.stringify({
        error: "id is required and must be a valid UUID",
        code: "VALIDATION_ERROR",
        details: { field: "id" },
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Fetch existing vehicle to confirm it exists and belongs to this tenant
  const { data: existingVehicle, error: fetchError } = await adminClient
    .from("transport_vehicles")
    .select("*")
    .eq("id", vehicleId)
    .eq("tenant_id", caller.tenant_id)
    .maybeSingle();

  if (fetchError) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch vehicle",
        code: "INTERNAL_ERROR",
        details: fetchError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  if (!existingVehicle) {
    return new Response(
      JSON.stringify({
        error: "Vehicle not found",
        code: "NOT_FOUND",
      } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Block deletion if vehicle is assigned to an in-progress trip (Property 5)
  const { data: activeTrips, error: tripCheckError } = await adminClient
    .from("transport_trips")
    .select("id")
    .eq("vehicle_id", vehicleId)
    .eq("tenant_id", caller.tenant_id)
    .eq("status", "in_progress")
    .limit(1);

  if (tripCheckError) {
    return new Response(
      JSON.stringify({
        error: "Failed to check active trips",
        code: "INTERNAL_ERROR",
        details: tripCheckError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  if (activeTrips && activeTrips.length > 0) {
    return new Response(
      JSON.stringify({
        error: "Cannot delete vehicle that is assigned to an in-progress trip",
        code: "VEHICLE_IN_USE",
        details: {
          active_trip_id: activeTrips[0].id,
          message: "Complete or cancel the active trip before deleting this vehicle",
        },
      } as ErrorResponse),
      { status: 409, headers }
    );
  }

  // Delete vehicle
  const { error: deleteError } = await adminClient
    .from("transport_vehicles")
    .delete()
    .eq("id", vehicleId)
    .eq("tenant_id", caller.tenant_id);

  if (deleteError) {
    return new Response(
      JSON.stringify({
        error: "Failed to delete vehicle",
        code: "INTERNAL_ERROR",
        details: deleteError.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Log vehicle deletion to audit log
  await logVehicleEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "vehicle_deleted",
    entity_id: vehicleId,
    details: {
      registration_number: existingVehicle.registration_number,
      make: existingVehicle.make,
      model: existingVehicle.model,
      year: existingVehicle.year,
      seating_capacity: existingVehicle.seating_capacity,
      status: existingVehicle.status,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Vehicle deleted successfully",
      id: vehicleId,
    }),
    { status: 200, headers }
  );
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
      case "GET":
        return await handleListVehicles(req, caller, headers);
      case "POST":
        return await handleCreateVehicle(req, caller, headers);
      case "PUT":
        return await handleUpdateVehicle(req, caller, headers);
      case "DELETE":
        return await handleDeleteVehicle(req, caller, headers);
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
