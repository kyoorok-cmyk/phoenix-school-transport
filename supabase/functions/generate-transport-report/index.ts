/**
 * Edge Function: generate-transport-report
 *
 * Generates transport reports for operators:
 * - daily_trip_summary: completed/cancelled trips and average delay in date range
 * - monthly_attendance: attendance rate per route and per student
 * - monthly_revenue: invoiced, collected, and outstanding amounts per route
 *
 * Auth: Requires caller to have 'operator' or 'admin' role.
 *
 * POST body:
 * {
 *   report_type: 'daily_trip_summary' | 'monthly_attendance' | 'monthly_revenue',
 *   date_from: string,  // YYYY-MM-DD
 *   date_to: string,    // YYYY-MM-DD
 *   route_id?: string   // Optional UUID filter
 * }
 *
 * Returns: JSON report data (CSV/PDF export handled on frontend).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { extractIp } from "../_shared/audit.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportType = "daily_trip_summary" | "monthly_attendance" | "monthly_revenue";

interface GenerateReportRequest {
  report_type: ReportType;
  date_from: string;
  date_to: string;
  route_id?: string;
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
const VALID_REPORT_TYPES: ReportType[] = ["daily_trip_summary", "monthly_attendance", "monthly_revenue"];

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

// ─── Helper: Validate request body ─────────────────────────────────────────────

function validateRequest(body: unknown): { valid: boolean; data?: GenerateReportRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body is required" };
  }

  const req = body as Record<string, unknown>;

  // Validate report_type
  if (!req.report_type || !VALID_REPORT_TYPES.includes(req.report_type as ReportType)) {
    return {
      valid: false,
      error: `report_type must be one of: ${VALID_REPORT_TYPES.join(", ")}`,
    };
  }

  // Validate date_from
  if (!req.date_from || typeof req.date_from !== "string") {
    return { valid: false, error: "date_from is required (YYYY-MM-DD)" };
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(req.date_from)) {
    return { valid: false, error: "date_from must be in YYYY-MM-DD format" };
  }
  const dateFrom = new Date(req.date_from + "T00:00:00Z");
  if (isNaN(dateFrom.getTime())) {
    return { valid: false, error: "date_from must be a valid date" };
  }

  // Validate date_to
  if (!req.date_to || typeof req.date_to !== "string") {
    return { valid: false, error: "date_to is required (YYYY-MM-DD)" };
  }
  if (!dateRegex.test(req.date_to)) {
    return { valid: false, error: "date_to must be in YYYY-MM-DD format" };
  }
  const dateTo = new Date(req.date_to + "T00:00:00Z");
  if (isNaN(dateTo.getTime())) {
    return { valid: false, error: "date_to must be a valid date" };
  }

  // Validate date range
  if (dateFrom > dateTo) {
    return { valid: false, error: "date_from must not be after date_to" };
  }

  // Validate optional route_id (UUID format)
  if (req.route_id !== undefined && req.route_id !== null) {
    if (typeof req.route_id !== "string") {
      return { valid: false, error: "route_id must be a string (UUID)" };
    }
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(req.route_id)) {
      return { valid: false, error: "route_id must be a valid UUID" };
    }
  }

  return {
    valid: true,
    data: {
      report_type: req.report_type as ReportType,
      date_from: req.date_from,
      date_to: req.date_to,
      route_id: req.route_id as string | undefined,
    },
  };
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
    console.error("[generate-transport-report][audit] Failed to log event:", error.message);
  }
}

// ─── Report: Daily Trip Summary ────────────────────────────────────────────────

async function generateDailyTripSummary(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  dateFrom: string,
  dateTo: string,
  routeId?: string
): Promise<Record<string, unknown>> {
  // Build query for trips in date range
  let query = adminClient
    .from("transport_trips")
    .select("id, trip_date, status, scheduled_departure, actual_departure, route_id")
    .eq("tenant_id", tenantId)
    .gte("trip_date", dateFrom)
    .lte("trip_date", dateTo);

  if (routeId) {
    query = query.eq("route_id", routeId);
  }

  const { data: trips, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch trips: ${error.message}`);
  }

  const allTrips = trips || [];
  const totalTrips = allTrips.length;
  const completedTrips = allTrips.filter((t) => t.status === "completed").length;
  const cancelledTrips = allTrips.filter((t) => t.status === "cancelled").length;
  const inProgressTrips = allTrips.filter((t) => t.status === "in_progress").length;
  const scheduledTrips = allTrips.filter((t) => t.status === "scheduled").length;

  // Calculate average delay for trips with actual_departure
  let totalDelayMinutes = 0;
  let tripsWithDelay = 0;

  for (const trip of allTrips) {
    if (trip.actual_departure && trip.scheduled_departure) {
      // scheduled_departure is TIME (HH:MM:SS), actual_departure is TIMESTAMPTZ
      // Parse actual departure and compare to scheduled time on the same date
      const actualDeparture = new Date(trip.actual_departure);
      const [hours, minutes, seconds] = trip.scheduled_departure.split(":").map(Number);
      const scheduledDate = new Date(trip.trip_date + "T00:00:00Z");
      scheduledDate.setUTCHours(hours, minutes, seconds || 0);

      const delayMs = actualDeparture.getTime() - scheduledDate.getTime();
      const delayMinutes = delayMs / (1000 * 60);

      // Only count positive delays
      if (delayMinutes > 0) {
        totalDelayMinutes += delayMinutes;
        tripsWithDelay++;
      }
    }
  }

  const averageDelayMinutes = tripsWithDelay > 0
    ? Math.round((totalDelayMinutes / tripsWithDelay) * 100) / 100
    : 0;

  // Group by date for daily breakdown
  const dailyBreakdown: Record<string, { completed: number; cancelled: number; in_progress: number; scheduled: number }> = {};
  for (const trip of allTrips) {
    if (!dailyBreakdown[trip.trip_date]) {
      dailyBreakdown[trip.trip_date] = { completed: 0, cancelled: 0, in_progress: 0, scheduled: 0 };
    }
    if (trip.status === "completed") dailyBreakdown[trip.trip_date].completed++;
    else if (trip.status === "cancelled") dailyBreakdown[trip.trip_date].cancelled++;
    else if (trip.status === "in_progress") dailyBreakdown[trip.trip_date].in_progress++;
    else if (trip.status === "scheduled") dailyBreakdown[trip.trip_date].scheduled++;
  }

  return {
    report_type: "daily_trip_summary",
    date_from: dateFrom,
    date_to: dateTo,
    route_id: routeId || null,
    summary: {
      total_trips: totalTrips,
      completed_trips: completedTrips,
      cancelled_trips: cancelledTrips,
      in_progress_trips: inProgressTrips,
      scheduled_trips: scheduledTrips,
      average_delay_minutes: averageDelayMinutes,
      trips_with_delay: tripsWithDelay,
    },
    daily_breakdown: dailyBreakdown,
  };
}

// ─── Report: Monthly Attendance ────────────────────────────────────────────────

async function generateMonthlyAttendance(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  dateFrom: string,
  dateTo: string,
  routeId?: string
): Promise<Record<string, unknown>> {
  // Fetch trips in date range (to know total expected trips per student)
  let tripsQuery = adminClient
    .from("transport_trips")
    .select("id, route_id, trip_date")
    .eq("tenant_id", tenantId)
    .gte("trip_date", dateFrom)
    .lte("trip_date", dateTo)
    .in("status", ["completed", "in_progress"]);

  if (routeId) {
    tripsQuery = tripsQuery.eq("route_id", routeId);
  }

  const { data: trips, error: tripsError } = await tripsQuery;

  if (tripsError) {
    throw new Error(`Failed to fetch trips: ${tripsError.message}`);
  }

  const allTrips = trips || [];
  const tripIds = allTrips.map((t) => t.id);

  // If no trips exist, return empty report
  if (tripIds.length === 0) {
    return {
      report_type: "monthly_attendance",
      date_from: dateFrom,
      date_to: dateTo,
      route_id: routeId || null,
      summary: {
        total_expected_records: 0,
        total_boarded: 0,
        overall_attendance_rate: 0,
      },
      by_route: [],
      by_student: [],
    };
  }

  // Fetch attendance records for those trips
  const { data: attendance, error: attendanceError } = await adminClient
    .from("transport_attendance")
    .select("id, trip_id, student_id, status, transport_trips!inner(route_id)")
    .eq("tenant_id", tenantId)
    .in("trip_id", tripIds);

  if (attendanceError) {
    throw new Error(`Failed to fetch attendance: ${attendanceError.message}`);
  }

  const allAttendance = attendance || [];

  // Fetch students with route assignments for context
  let studentsQuery = adminClient
    .from("transport_students")
    .select("id, full_name, assigned_route_id")
    .eq("tenant_id", tenantId)
    .eq("status", "active");

  if (routeId) {
    studentsQuery = studentsQuery.eq("assigned_route_id", routeId);
  }

  const { data: students, error: studentsError } = await studentsQuery;

  if (studentsError) {
    throw new Error(`Failed to fetch students: ${studentsError.message}`);
  }

  const allStudents = students || [];

  // Count trips per route
  const tripsPerRoute: Record<string, number> = {};
  for (const trip of allTrips) {
    tripsPerRoute[trip.route_id] = (tripsPerRoute[trip.route_id] || 0) + 1;
  }

  // Calculate attendance per student
  const studentAttendance: Record<string, { boarded: number; total_expected: number }> = {};
  for (const student of allStudents) {
    if (!student.assigned_route_id) continue;
    const expectedTrips = tripsPerRoute[student.assigned_route_id] || 0;
    studentAttendance[student.id] = { boarded: 0, total_expected: expectedTrips };
  }

  // Count boarded records per student
  for (const record of allAttendance) {
    if (record.status === "boarded" && studentAttendance[record.student_id]) {
      studentAttendance[record.student_id].boarded++;
    }
  }

  // Build per-student report
  const byStudent = allStudents
    .filter((s) => s.assigned_route_id && studentAttendance[s.id])
    .map((s) => {
      const att = studentAttendance[s.id];
      const rate = att.total_expected > 0
        ? Math.round((att.boarded / att.total_expected) * 10000) / 100
        : 0;
      return {
        student_id: s.id,
        student_name: s.full_name,
        route_id: s.assigned_route_id,
        boarded: att.boarded,
        total_expected: att.total_expected,
        attendance_rate_percent: rate,
      };
    });

  // Build per-route report
  // Fetch route names
  const routeIds = [...new Set(allTrips.map((t) => t.route_id))];
  const { data: routes } = await adminClient
    .from("transport_routes")
    .select("id, route_name")
    .in("id", routeIds);

  const routeNameMap: Record<string, string> = {};
  for (const r of routes || []) {
    routeNameMap[r.id] = r.route_name;
  }

  const byRoute = routeIds.map((rId) => {
    const routeStudents = byStudent.filter((s) => s.route_id === rId);
    const totalBoarded = routeStudents.reduce((sum, s) => sum + s.boarded, 0);
    const totalExpected = routeStudents.reduce((sum, s) => sum + s.total_expected, 0);
    const rate = totalExpected > 0
      ? Math.round((totalBoarded / totalExpected) * 10000) / 100
      : 0;

    return {
      route_id: rId,
      route_name: routeNameMap[rId] || "Unknown",
      total_boarded: totalBoarded,
      total_expected: totalExpected,
      attendance_rate_percent: rate,
      student_count: routeStudents.length,
    };
  });

  // Overall summary
  const totalBoarded = byStudent.reduce((sum, s) => sum + s.boarded, 0);
  const totalExpected = byStudent.reduce((sum, s) => sum + s.total_expected, 0);
  const overallRate = totalExpected > 0
    ? Math.round((totalBoarded / totalExpected) * 10000) / 100
    : 0;

  return {
    report_type: "monthly_attendance",
    date_from: dateFrom,
    date_to: dateTo,
    route_id: routeId || null,
    summary: {
      total_expected_records: totalExpected,
      total_boarded: totalBoarded,
      overall_attendance_rate_percent: overallRate,
    },
    by_route: byRoute,
    by_student: byStudent,
  };
}

// ─── Report: Monthly Revenue ───────────────────────────────────────────────────

async function generateMonthlyRevenue(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string,
  dateFrom: string,
  dateTo: string,
  routeId?: string
): Promise<Record<string, unknown>> {
  // Fetch invoices in date range (using billing_month within range)
  let invoicesQuery = adminClient
    .from("transport_invoices")
    .select("id, student_id, amount, status, billing_month")
    .eq("tenant_id", tenantId)
    .gte("billing_month", dateFrom)
    .lte("billing_month", dateTo);

  const { data: invoices, error: invoicesError } = await invoicesQuery;

  if (invoicesError) {
    throw new Error(`Failed to fetch invoices: ${invoicesError.message}`);
  }

  const allInvoices = invoices || [];

  // Get invoice IDs to fetch payments
  const invoiceIds = allInvoices.map((inv) => inv.id);

  // Fetch payments for those invoices
  let payments: Array<{ id: string; invoice_id: string; amount: number }> = [];
  if (invoiceIds.length > 0) {
    const { data: paymentData, error: paymentsError } = await adminClient
      .from("transport_payments")
      .select("id, invoice_id, amount")
      .in("invoice_id", invoiceIds);

    if (paymentsError) {
      throw new Error(`Failed to fetch payments: ${paymentsError.message}`);
    }
    payments = paymentData || [];
  }

  // Get student-to-route mapping for grouping by route
  const studentIds = [...new Set(allInvoices.map((inv) => inv.student_id))];
  let studentRouteMap: Record<string, string> = {};

  if (studentIds.length > 0) {
    let studentsQuery = adminClient
      .from("transport_students")
      .select("id, assigned_route_id")
      .in("id", studentIds);

    if (routeId) {
      studentsQuery = studentsQuery.eq("assigned_route_id", routeId);
    }

    const { data: studentData, error: studentsError } = await studentsQuery;

    if (studentsError) {
      throw new Error(`Failed to fetch students: ${studentsError.message}`);
    }

    for (const s of studentData || []) {
      if (s.assigned_route_id) {
        studentRouteMap[s.id] = s.assigned_route_id;
      }
    }
  }

  // Filter invoices to only those for students on the requested route (if route_id specified)
  const filteredInvoices = routeId
    ? allInvoices.filter((inv) => studentRouteMap[inv.student_id] === routeId)
    : allInvoices;

  // Build payments lookup by invoice_id
  const paymentsByInvoice: Record<string, number> = {};
  for (const p of payments) {
    paymentsByInvoice[p.invoice_id] = (paymentsByInvoice[p.invoice_id] || 0) + Number(p.amount);
  }

  // Calculate totals
  const totalInvoiced = filteredInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0);
  const totalCollected = filteredInvoices.reduce(
    (sum, inv) => sum + (paymentsByInvoice[inv.id] || 0),
    0
  );
  const totalOutstanding = totalInvoiced - totalCollected;

  // Group by route
  const routeRevenue: Record<string, { invoiced: number; collected: number; invoice_count: number }> = {};

  for (const inv of filteredInvoices) {
    const rId = studentRouteMap[inv.student_id] || "unassigned";
    if (!routeRevenue[rId]) {
      routeRevenue[rId] = { invoiced: 0, collected: 0, invoice_count: 0 };
    }
    routeRevenue[rId].invoiced += Number(inv.amount);
    routeRevenue[rId].collected += paymentsByInvoice[inv.id] || 0;
    routeRevenue[rId].invoice_count++;
  }

  // Fetch route names
  const routeIds = Object.keys(routeRevenue).filter((id) => id !== "unassigned");
  let routeNameMap: Record<string, string> = {};
  if (routeIds.length > 0) {
    const { data: routes } = await adminClient
      .from("transport_routes")
      .select("id, route_name")
      .in("id", routeIds);

    for (const r of routes || []) {
      routeNameMap[r.id] = r.route_name;
    }
  }

  const byRoute = Object.entries(routeRevenue).map(([rId, data]) => ({
    route_id: rId,
    route_name: routeNameMap[rId] || (rId === "unassigned" ? "Unassigned" : "Unknown"),
    invoiced_amount: Math.round(data.invoiced * 100) / 100,
    collected_amount: Math.round(data.collected * 100) / 100,
    outstanding_amount: Math.round((data.invoiced - data.collected) * 100) / 100,
    invoice_count: data.invoice_count,
  }));

  return {
    report_type: "monthly_revenue",
    date_from: dateFrom,
    date_to: dateTo,
    route_id: routeId || null,
    summary: {
      total_invoiced: Math.round(totalInvoiced * 100) / 100,
      total_collected: Math.round(totalCollected * 100) / 100,
      total_outstanding: Math.round(totalOutstanding * 100) / 100,
      total_invoices: filteredInvoices.length,
    },
    by_route: byRoute,
  };
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
    let body: unknown;
    try {
      const text = await req.text();
      if (!text.trim()) {
        return new Response(
          JSON.stringify({ error: "Request body is required", code: "VALIDATION_ERROR" } as ErrorResponse),
          { status: 400, headers }
        );
      }
      body = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    // Validate request
    const validation = validateRequest(body);
    if (!validation.valid || !validation.data) {
      return new Response(
        JSON.stringify({ error: validation.error, code: "VALIDATION_ERROR" } as ErrorResponse),
        { status: 400, headers }
      );
    }

    const { report_type, date_from, date_to, route_id } = validation.data;
    const adminClient = getAdminClient();

    // Generate report based on type
    let reportData: Record<string, unknown>;

    switch (report_type) {
      case "daily_trip_summary":
        reportData = await generateDailyTripSummary(adminClient, caller.tenant_id, date_from, date_to, route_id);
        break;
      case "monthly_attendance":
        reportData = await generateMonthlyAttendance(adminClient, caller.tenant_id, date_from, date_to, route_id);
        break;
      case "monthly_revenue":
        reportData = await generateMonthlyRevenue(adminClient, caller.tenant_id, date_from, date_to, route_id);
        break;
      default:
        return new Response(
          JSON.stringify({ error: "Invalid report_type", code: "VALIDATION_ERROR" } as ErrorResponse),
          { status: 400, headers }
        );
    }

    // Log audit event for report generation
    await logAuditEvent(adminClient, {
      tenant_id: caller.tenant_id,
      user_id: caller.id,
      event_type: "report_generated",
      entity_type: "report",
      entity_id: null,
      details: {
        report_type,
        date_from,
        date_to,
        route_id: route_id || null,
      },
      ip_address: ip,
    });

    return new Response(JSON.stringify(reportData), { status: 200, headers });
  } catch (error) {
    // If verifyCallerRole threw a Response, return it with CORS headers
    if (error instanceof Response) {
      const body = await error.text();
      return new Response(body, { status: error.status, headers });
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[generate-transport-report] Unhandled error:", message);
    return new Response(
      JSON.stringify({ error: message, code: "INTERNAL_ERROR" } as ErrorResponse),
      { status: 500, headers }
    );
  }
});
