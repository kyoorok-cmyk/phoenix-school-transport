/**
 * Edge Function: manage-students
 *
 * CRUD operations for transport students with guardian management,
 * stop-route consistency validation, and vehicle capacity enforcement.
 *
 * Endpoints:
 *   GET    - List students for the tenant (with guardian info, route/stop)
 *   POST   - Create a student with at least one guardian
 *   PUT    - Update student (route/stop reassignment with validations)
 *   DELETE - Soft-delete (set status='removed'), notify guardians
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { validateRequired, validateUUID } from "../_shared/validation.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GuardianInput {
  full_name: string;
  phone_number: string;
  whatsapp_number?: string;
  email?: string;
  relationship?: string;
  is_primary?: boolean;
}

interface CreateStudentRequest {
  full_name: string;
  grade: string;
  school_name: string;
  assigned_route_id?: string | null;
  assigned_stop_id?: string | null;
  guardians: GuardianInput[];
}

interface UpdateStudentRequest {
  student_id: string;
  full_name?: string;
  grade?: string;
  school_name?: string;
  assigned_route_id?: string | null;
  assigned_stop_id?: string | null;
  status?: "active" | "suspended";
}

interface DeleteStudentRequest {
  student_id: string;
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
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// ─── Helper: Log transport audit event ─────────────────────────────────────────

async function logAuditEvent(
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
    console.error("[manage-students][audit] Failed to log event:", error.message);
  }
}

// ─── Helper: Validate stop belongs to route (Property 17) ──────────────────────

async function validateStopRouteConsistency(
  adminClient: ReturnType<typeof createClient>,
  stopId: string,
  routeId: string,
  tenantId: string
): Promise<{ valid: boolean; error?: string }> {
  const { data: stop, error } = await adminClient
    .from("transport_stops")
    .select("id, route_id")
    .eq("id", stopId)
    .eq("tenant_id", tenantId)
    .single();

  if (error || !stop) {
    return { valid: false, error: "Stop not found" };
  }

  if (stop.route_id !== routeId) {
    return {
      valid: false,
      error: "Assigned stop does not belong to the assigned route",
    };
  }

  return { valid: true };
}

// ─── Helper: Validate vehicle capacity (Property 18) ───────────────────────────

async function validateVehicleCapacity(
  adminClient: ReturnType<typeof createClient>,
  routeId: string,
  tenantId: string,
  excludeStudentId?: string
): Promise<{ valid: boolean; capacity?: number; current?: number; error?: string }> {
  // Get the vehicle assigned to this route via active schedules
  const { data: schedules, error: schedError } = await adminClient
    .from("transport_schedules")
    .select("vehicle_id")
    .eq("route_id", routeId)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .limit(1);

  if (schedError) {
    return { valid: false, error: "Failed to check vehicle assignment" };
  }

  // If no active schedule/vehicle assigned, capacity is unrestricted
  if (!schedules || schedules.length === 0) {
    return { valid: true };
  }

  const vehicleId = schedules[0].vehicle_id;

  // Get vehicle seating capacity
  const { data: vehicle, error: vehError } = await adminClient
    .from("transport_vehicles")
    .select("seating_capacity")
    .eq("id", vehicleId)
    .eq("tenant_id", tenantId)
    .single();

  if (vehError || !vehicle) {
    return { valid: false, error: "Vehicle not found for route schedule" };
  }

  // Count active students currently assigned to this route
  let query = adminClient
    .from("transport_students")
    .select("id", { count: "exact", head: true })
    .eq("assigned_route_id", routeId)
    .eq("tenant_id", tenantId)
    .eq("status", "active");

  // Exclude the current student if updating (they're already counted)
  if (excludeStudentId) {
    query = query.neq("id", excludeStudentId);
  }

  const { count, error: countError } = await query;

  if (countError) {
    return { valid: false, error: "Failed to count students on route" };
  }

  const currentCount = count || 0;
  const capacity = vehicle.seating_capacity;

  if (currentCount >= capacity) {
    return {
      valid: false,
      capacity,
      current: currentCount,
      error: `Route capacity exceeded: ${currentCount}/${capacity} seats filled`,
    };
  }

  return { valid: true, capacity, current: currentCount };
}

// ─── Helper: Notify guardians of a student ─────────────────────────────────────

async function notifyGuardians(
  adminClient: ReturnType<typeof createClient>,
  studentId: string,
  tenantId: string,
  notificationType: string,
  templateParams: Record<string, string>
): Promise<void> {
  // Get all guardians for this student
  const { data: guardianLinks, error } = await adminClient
    .from("transport_student_guardians")
    .select("guardian_id")
    .eq("student_id", studentId);

  if (error || !guardianLinks || guardianLinks.length === 0) {
    console.error("[manage-students] No guardians found for notification:", studentId);
    return;
  }

  // Get guardian details for notification channel
  const guardianIds = guardianLinks.map((g) => g.guardian_id);
  const { data: guardians, error: gError } = await adminClient
    .from("transport_guardians")
    .select("id, preferred_notification_channel")
    .in("id", guardianIds);

  if (gError || !guardians) {
    console.error("[manage-students] Failed to fetch guardian details:", gError?.message);
    return;
  }

  // Insert notification records for each guardian
  const notifications = guardians.map((guardian) => ({
    tenant_id: tenantId,
    guardian_id: guardian.id,
    notification_type: notificationType,
    channel: guardian.preferred_notification_channel || "sms",
    template_name: notificationType,
    template_params: templateParams,
    delivery_status: "pending",
  }));

  const { error: notifError } = await adminClient
    .from("transport_notifications")
    .insert(notifications);

  if (notifError) {
    console.error("[manage-students] Failed to create notifications:", notifError.message);
  }
}

// ─── Handler: GET - List students ──────────────────────────────────────────────

async function handleListStudents(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  const adminClient = getAdminClient();

  // Query students for this tenant with route and stop info
  const { data: students, error } = await adminClient
    .from("transport_students")
    .select(`
      id,
      full_name,
      grade,
      school_name,
      assigned_route_id,
      assigned_stop_id,
      status,
      created_at,
      updated_at,
      transport_routes!assigned_route_id (id, route_name),
      transport_stops!assigned_stop_id (id, stop_name)
    `)
    .eq("tenant_id", caller.tenant_id)
    .neq("status", "removed")
    .order("full_name", { ascending: true });

  if (error) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch students",
        code: "INTERNAL_ERROR",
        details: error.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Fetch guardians for all students
  const studentIds = (students || []).map((s) => s.id);
  let guardianMap: Record<string, unknown[]> = {};

  if (studentIds.length > 0) {
    const { data: guardianLinks, error: gError } = await adminClient
      .from("transport_student_guardians")
      .select(`
        student_id,
        relationship,
        is_primary,
        transport_guardians!guardian_id (id, full_name, phone_number, whatsapp_number, email)
      `)
      .in("student_id", studentIds);

    if (!gError && guardianLinks) {
      guardianMap = {};
      for (const link of guardianLinks) {
        if (!guardianMap[link.student_id]) {
          guardianMap[link.student_id] = [];
        }
        guardianMap[link.student_id].push({
          ...link.transport_guardians,
          relationship: link.relationship,
          is_primary: link.is_primary,
        });
      }
    }
  }

  // Assemble response
  const result = (students || []).map((s) => ({
    ...s,
    guardians: guardianMap[s.id] || [],
  }));

  return new Response(
    JSON.stringify({ students: result, count: result.length }),
    { status: 200, headers }
  );
}

// ─── Handler: POST - Create student ────────────────────────────────────────────

async function handleCreateStudent(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  let body: CreateStudentRequest;
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
  const { missing } = validateRequired(
    { full_name: body.full_name, grade: body.grade, school_name: body.school_name },
    ["full_name", "grade", "school_name"]
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

  // Property 16: Require at least one guardian
  if (!body.guardians || !Array.isArray(body.guardians) || body.guardians.length === 0) {
    return new Response(
      JSON.stringify({
        error: "At least one guardian contact is required",
        code: "GUARDIAN_REQUIRED",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Validate each guardian has required fields
  for (let i = 0; i < body.guardians.length; i++) {
    const g = body.guardians[i];
    if (!g.full_name || !g.full_name.trim()) {
      return new Response(
        JSON.stringify({
          error: `Guardian ${i + 1}: full_name is required`,
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
    if (!g.phone_number || !g.phone_number.trim()) {
      return new Response(
        JSON.stringify({
          error: `Guardian ${i + 1}: phone_number is required`,
          code: "VALIDATION_ERROR",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Validate UUIDs if provided
  if (body.assigned_route_id && !validateUUID(body.assigned_route_id)) {
    return new Response(
      JSON.stringify({
        error: "Invalid assigned_route_id format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  if (body.assigned_stop_id && !validateUUID(body.assigned_stop_id)) {
    return new Response(
      JSON.stringify({
        error: "Invalid assigned_stop_id format",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Property 17: Validate stop belongs to route
  if (body.assigned_stop_id && body.assigned_route_id) {
    const stopCheck = await validateStopRouteConsistency(
      adminClient,
      body.assigned_stop_id,
      body.assigned_route_id,
      caller.tenant_id
    );
    if (!stopCheck.valid) {
      return new Response(
        JSON.stringify({
          error: stopCheck.error || "Stop-route mismatch",
          code: "STOP_ROUTE_MISMATCH",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // If stop is provided without route, reject
  if (body.assigned_stop_id && !body.assigned_route_id) {
    return new Response(
      JSON.stringify({
        error: "assigned_route_id is required when assigned_stop_id is provided",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Property 18: Validate vehicle capacity
  if (body.assigned_route_id) {
    const capacityCheck = await validateVehicleCapacity(
      adminClient,
      body.assigned_route_id,
      caller.tenant_id
    );
    if (!capacityCheck.valid) {
      return new Response(
        JSON.stringify({
          error: capacityCheck.error || "Capacity exceeded",
          code: "CAPACITY_EXCEEDED",
          details: {
            capacity: capacityCheck.capacity,
            current: capacityCheck.current,
          },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Verify route exists if provided
  if (body.assigned_route_id) {
    const { data: route, error: routeErr } = await adminClient
      .from("transport_routes")
      .select("id")
      .eq("id", body.assigned_route_id)
      .eq("tenant_id", caller.tenant_id)
      .single();

    if (routeErr || !route) {
      return new Response(
        JSON.stringify({
          error: "Route not found",
          code: "NOT_FOUND",
          details: "The specified assigned_route_id does not exist",
        } as ErrorResponse),
        { status: 404, headers }
      );
    }
  }

  // --- Insert student ---
  const { data: student, error: studentError } = await adminClient
    .from("transport_students")
    .insert({
      tenant_id: caller.tenant_id,
      full_name: body.full_name.trim(),
      grade: body.grade.trim(),
      school_name: body.school_name.trim(),
      assigned_route_id: body.assigned_route_id || null,
      assigned_stop_id: body.assigned_stop_id || null,
      status: "active",
    })
    .select("id")
    .single();

  if (studentError || !student) {
    return new Response(
      JSON.stringify({
        error: "Failed to create student",
        code: "INTERNAL_ERROR",
        details: studentError?.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // --- Insert guardians and link to student ---
  const guardianIds: string[] = [];

  for (const g of body.guardians) {
    // Insert guardian record
    const { data: guardian, error: gErr } = await adminClient
      .from("transport_guardians")
      .insert({
        tenant_id: caller.tenant_id,
        full_name: g.full_name.trim(),
        phone_number: g.phone_number.trim(),
        whatsapp_number: g.whatsapp_number?.trim() || null,
        email: g.email?.trim() || null,
        preferred_notification_channel: g.whatsapp_number ? "whatsapp" : "sms",
      })
      .select("id")
      .single();

    if (gErr || !guardian) {
      // Rollback: delete the student we just created
      await adminClient
        .from("transport_students")
        .delete()
        .eq("id", student.id);

      return new Response(
        JSON.stringify({
          error: "Failed to create guardian record",
          code: "INTERNAL_ERROR",
          details: gErr?.message,
        } as ErrorResponse),
        { status: 500, headers }
      );
    }

    guardianIds.push(guardian.id);

    // Create student-guardian link
    const { error: linkErr } = await adminClient
      .from("transport_student_guardians")
      .insert({
        student_id: student.id,
        guardian_id: guardian.id,
        relationship: g.relationship || "parent",
        is_primary: g.is_primary || (guardianIds.length === 1),
      });

    if (linkErr) {
      console.error("[manage-students] Failed to link guardian:", linkErr.message);
    }
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "student_created",
    entity_type: "student",
    entity_id: student.id,
    details: {
      full_name: body.full_name,
      grade: body.grade,
      school_name: body.school_name,
      assigned_route_id: body.assigned_route_id || null,
      assigned_stop_id: body.assigned_stop_id || null,
      guardian_count: guardianIds.length,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Student created successfully",
      student_id: student.id,
      guardian_ids: guardianIds,
    }),
    { status: 201, headers }
  );
}

// ─── Handler: PUT - Update student ─────────────────────────────────────────────

async function handleUpdateStudent(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  let body: UpdateStudentRequest;
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

  // Validate student_id
  if (!body.student_id || !validateUUID(body.student_id)) {
    return new Response(
      JSON.stringify({
        error: "Valid student_id is required",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Fetch existing student
  const { data: existingStudent, error: fetchErr } = await adminClient
    .from("transport_students")
    .select("*")
    .eq("id", body.student_id)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchErr || !existingStudent) {
    return new Response(
      JSON.stringify({
        error: "Student not found",
        code: "NOT_FOUND",
      } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Determine new route/stop values
  const newRouteId = body.assigned_route_id !== undefined
    ? body.assigned_route_id
    : existingStudent.assigned_route_id;
  const newStopId = body.assigned_stop_id !== undefined
    ? body.assigned_stop_id
    : existingStudent.assigned_stop_id;

  // If route is being removed, also clear stop
  const finalRouteId = newRouteId;
  const finalStopId = newRouteId === null ? null : newStopId;

  // Property 17: Validate stop-route consistency
  if (finalStopId && finalRouteId) {
    const stopCheck = await validateStopRouteConsistency(
      adminClient,
      finalStopId,
      finalRouteId,
      caller.tenant_id
    );
    if (!stopCheck.valid) {
      return new Response(
        JSON.stringify({
          error: stopCheck.error || "Stop-route mismatch",
          code: "STOP_ROUTE_MISMATCH",
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // If stop is provided without route, reject
  if (finalStopId && !finalRouteId) {
    return new Response(
      JSON.stringify({
        error: "assigned_route_id is required when assigned_stop_id is provided",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  // Property 18: Validate vehicle capacity if assigning to a new route
  const routeChanged = finalRouteId !== existingStudent.assigned_route_id;
  if (finalRouteId && routeChanged) {
    const capacityCheck = await validateVehicleCapacity(
      adminClient,
      finalRouteId,
      caller.tenant_id,
      body.student_id
    );
    if (!capacityCheck.valid) {
      return new Response(
        JSON.stringify({
          error: capacityCheck.error || "Capacity exceeded",
          code: "CAPACITY_EXCEEDED",
          details: {
            capacity: capacityCheck.capacity,
            current: capacityCheck.current,
          },
        } as ErrorResponse),
        { status: 400, headers }
      );
    }
  }

  // Detect if student is being removed from route (for guardian notification)
  const removedFromRoute =
    existingStudent.assigned_route_id !== null && finalRouteId === null;

  // Build update object
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.full_name !== undefined) updateData.full_name = body.full_name.trim();
  if (body.grade !== undefined) updateData.grade = body.grade.trim();
  if (body.school_name !== undefined) updateData.school_name = body.school_name.trim();
  if (body.status !== undefined) updateData.status = body.status;
  if (body.assigned_route_id !== undefined) updateData.assigned_route_id = finalRouteId;
  if (body.assigned_stop_id !== undefined || body.assigned_route_id !== undefined) {
    updateData.assigned_stop_id = finalStopId;
  }

  // Perform update
  const { data: updatedStudent, error: updateErr } = await adminClient
    .from("transport_students")
    .update(updateData)
    .eq("id", body.student_id)
    .eq("tenant_id", caller.tenant_id)
    .select("id")
    .single();

  if (updateErr || !updatedStudent) {
    return new Response(
      JSON.stringify({
        error: "Failed to update student",
        code: "INTERNAL_ERROR",
        details: updateErr?.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Notify guardians if student removed from route (Requirement 9.5)
  if (removedFromRoute) {
    await notifyGuardians(
      adminClient,
      body.student_id,
      caller.tenant_id,
      "student_removed_from_route",
      {
        student_name: existingStudent.full_name,
        route_name: "route",
      }
    );
  }

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "student_updated",
    entity_type: "student",
    entity_id: body.student_id,
    details: {
      changes: updateData,
      removed_from_route: removedFromRoute,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Student updated successfully",
      student_id: body.student_id,
    }),
    { status: 200, headers }
  );
}

// ─── Handler: DELETE - Soft-delete student ──────────────────────────────────────

async function handleDeleteStudent(
  req: Request,
  caller: CallerInfo,
  headers: Record<string, string>
): Promise<Response> {
  let body: DeleteStudentRequest;
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

  // Validate student_id
  if (!body.student_id || !validateUUID(body.student_id)) {
    return new Response(
      JSON.stringify({
        error: "Valid student_id is required",
        code: "VALIDATION_ERROR",
      } as ErrorResponse),
      { status: 400, headers }
    );
  }

  const adminClient = getAdminClient();

  // Fetch existing student
  const { data: existingStudent, error: fetchErr } = await adminClient
    .from("transport_students")
    .select("*")
    .eq("id", body.student_id)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (fetchErr || !existingStudent) {
    return new Response(
      JSON.stringify({
        error: "Student not found",
        code: "NOT_FOUND",
      } as ErrorResponse),
      { status: 404, headers }
    );
  }

  // Soft-delete: set status to 'removed' and clear route/stop
  const { error: updateErr } = await adminClient
    .from("transport_students")
    .update({
      status: "removed",
      assigned_route_id: null,
      assigned_stop_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.student_id)
    .eq("tenant_id", caller.tenant_id);

  if (updateErr) {
    return new Response(
      JSON.stringify({
        error: "Failed to remove student",
        code: "INTERNAL_ERROR",
        details: updateErr.message,
      } as ErrorResponse),
      { status: 500, headers }
    );
  }

  // Notify guardians of removal (Requirement 9.5)
  await notifyGuardians(
    adminClient,
    body.student_id,
    caller.tenant_id,
    "student_removed",
    {
      student_name: existingStudent.full_name,
    }
  );

  // Log audit event
  await logAuditEvent(adminClient, {
    tenant_id: caller.tenant_id,
    user_id: caller.id,
    event_type: "student_removed",
    entity_type: "student",
    entity_id: body.student_id,
    details: {
      full_name: existingStudent.full_name,
      previous_route_id: existingStudent.assigned_route_id,
      performed_by: caller.id,
    },
    ip_address: ip,
  });

  return new Response(
    JSON.stringify({
      message: "Student removed successfully",
      student_id: body.student_id,
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
        return await handleListStudents(req, caller, headers);
      case "POST":
        return await handleCreateStudent(req, caller, headers);
      case "PUT":
        return await handleUpdateStudent(req, caller, headers);
      case "DELETE":
        return await handleDeleteStudent(req, caller, headers);
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
