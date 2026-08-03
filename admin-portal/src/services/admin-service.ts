import { supabaseAdmin } from './supabase-admin';

/**
 * Admin service for transport tenant management.
 * Provides data access and actions for vendor administrators
 * to manage transport tenants through the Admin Portal.
 *
 * All queries rely on vendor_admin RLS policies for cross-tenant access.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TransportTenantSummary {
  id: string;
  company_name: string;
  contact_email: string;
  subscription_tier: string;
  subscription_status: string;
  created_at: string;
  active_vehicle_count: number;
  active_student_count: number;
}

export interface TransportTenantDetail {
  id: string;
  company_name: string;
  contact_email: string;
  contact_phone: string | null;
  physical_address: string | null;
  subscription_tier: string;
  subscription_status: string;
  created_at: string;
  updated_at: string;
}

export interface TenantUsageMetrics {
  active_vehicles: number;
  active_students: number;
  active_routes: number;
  active_schedules: number;
  trips_this_month: number;
  completed_trips_this_month: number;
  cancelled_trips_this_month: number;
}

export interface TenantBillingEntry {
  id: string;
  invoice_number: string;
  billing_month: string;
  amount: number;
  status: string;
  due_date: string;
  created_at: string;
}

export interface ProvisionTenantPayload {
  company_name: string;
  contact_email: string;
  contact_phone?: string;
  physical_address?: string;
  tier: string;
  admin_password: string;
  admin_display_name: string;
}

export interface ProvisionResult {
  success: boolean;
  tenant_id?: string;
  error?: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

// ─── Tenant List ─────────────────────────────────────────────────────────────

/**
 * Fetches all tenants with transport-specific metrics (vehicle count, student count).
 * Supports filtering by name/email search and subscription status.
 */
export async function fetchTransportTenants(options: {
  search?: string;
  status?: string;
  tier?: string;
}): Promise<TransportTenantSummary[]> {
  const { search, status, tier } = options;

  let query = supabaseAdmin
    .from('tenants')
    .select('id, company_name, contact_email, subscription_tier, subscription_status, created_at')
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(`company_name.ilike.%${search}%,contact_email.ilike.%${search}%`);
  }
  if (status) {
    query = query.eq('subscription_status', status);
  }
  if (tier) {
    query = query.eq('subscription_tier', tier);
  }

  const { data: tenants, error } = await query;

  if (error) {
    console.error('Failed to fetch tenants:', error);
    throw new Error(`Failed to fetch tenants: ${error.message}`);
  }

  // Enrich with transport-specific counts
  const enriched: TransportTenantSummary[] = [];

  for (const tenant of tenants ?? []) {
    const [vehicleCount, studentCount] = await Promise.all([
      getActiveVehicleCount(tenant.id),
      getActiveStudentCount(tenant.id),
    ]);

    enriched.push({
      ...tenant,
      active_vehicle_count: vehicleCount,
      active_student_count: studentCount,
    });
  }

  return enriched;
}

// ─── Tenant Detail ───────────────────────────────────────────────────────────

/**
 * Fetches full tenant detail for transport admin view.
 */
export async function fetchTransportTenantDetail(
  tenantId: string
): Promise<TransportTenantDetail | null> {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (error) {
    console.error('Failed to fetch tenant detail:', error);
    return null;
  }

  return data;
}

/**
 * Fetches usage metrics for a specific transport tenant.
 */
export async function fetchTenantUsageMetrics(
  tenantId: string
): Promise<TenantUsageMetrics> {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];

  const [
    activeVehicles,
    activeStudents,
    activeRoutes,
    activeSchedules,
    tripsThisMonth,
    completedTrips,
    cancelledTrips,
  ] = await Promise.all([
    getActiveVehicleCount(tenantId),
    getActiveStudentCount(tenantId),
    getActiveRouteCount(tenantId),
    getActiveScheduleCount(tenantId),
    getTripsCountThisMonth(tenantId, firstOfMonth),
    getTripsCountByStatus(tenantId, firstOfMonth, 'completed'),
    getTripsCountByStatus(tenantId, firstOfMonth, 'cancelled'),
  ]);

  return {
    active_vehicles: activeVehicles,
    active_students: activeStudents,
    active_routes: activeRoutes,
    active_schedules: activeSchedules,
    trips_this_month: tripsThisMonth,
    completed_trips_this_month: completedTrips,
    cancelled_trips_this_month: cancelledTrips,
  };
}

/**
 * Fetches billing history (invoices) for a specific tenant.
 */
export async function fetchTenantBillingHistory(
  tenantId: string,
  limit: number = 20
): Promise<TenantBillingEntry[]> {
  const { data, error } = await supabaseAdmin
    .from('transport_invoices')
    .select('id, invoice_number, billing_month, amount, status, due_date, created_at')
    .eq('tenant_id', tenantId)
    .order('billing_month', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Failed to fetch billing history:', error);
    return [];
  }

  return data ?? [];
}

// ─── Tenant Actions ──────────────────────────────────────────────────────────

/**
 * Provisions a new transport tenant by calling the provision-transport-tenant Edge Function.
 */
export async function provisionTransportTenant(
  payload: ProvisionTenantPayload
): Promise<ProvisionResult> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;

  const { data: sessionData } = await supabaseAdmin.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    return { success: false, error: 'Not authenticated. Please sign in again.' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/provision-transport-tenant`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          company_name: payload.company_name,
          contact_email: payload.contact_email,
          contact_phone: payload.contact_phone || undefined,
          physical_address: payload.physical_address || undefined,
          tier: payload.tier,
          admin_password: payload.admin_password,
          admin_display_name: payload.admin_display_name,
        }),
      }
    );

    const result = await response.json();

    if (response.ok && result.tenant_id) {
      return { success: true, tenant_id: result.tenant_id };
    }

    return {
      success: false,
      error: result.error || result.details?.join(', ') || 'Failed to provision tenant',
    };
  } catch (err) {
    console.error('Provision transport tenant failed:', err);
    return { success: false, error: 'Network error — please try again.' };
  }
}

/**
 * Suspends a transport tenant. All users of the tenant will be denied access.
 */
export async function suspendTenant(tenantId: string): Promise<ActionResult> {
  try {
    const { error: tenantError } = await supabaseAdmin
      .from('tenants')
      .update({ subscription_status: 'suspended' })
      .eq('id', tenantId);

    if (tenantError) {
      throw tenantError;
    }

    // Also update subscription record if it exists
    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'suspended' })
      .eq('tenant_id', tenantId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Failed to suspend tenant:', err);
    return { success: false, error: `Failed to suspend tenant: ${message}` };
  }
}

/**
 * Reactivates a previously suspended transport tenant.
 */
export async function reactivateTenant(tenantId: string): Promise<ActionResult> {
  try {
    const { error: tenantError } = await supabaseAdmin
      .from('tenants')
      .update({ subscription_status: 'active' })
      .eq('id', tenantId);

    if (tenantError) {
      throw tenantError;
    }

    // Also update subscription record if it exists
    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'active' })
      .eq('tenant_id', tenantId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Failed to reactivate tenant:', err);
    return { success: false, error: `Failed to reactivate tenant: ${message}` };
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function getActiveVehicleCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_vehicles')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('status', ['available', 'assigned']);

  if (error) {
    console.warn(`Failed to get vehicle count for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}

async function getActiveStudentCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_students')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  if (error) {
    console.warn(`Failed to get student count for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}

async function getActiveRouteCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_routes')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  if (error) {
    console.warn(`Failed to get route count for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}

async function getActiveScheduleCount(tenantId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_schedules')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  if (error) {
    console.warn(`Failed to get schedule count for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}

async function getTripsCountThisMonth(
  tenantId: string,
  firstOfMonth: string
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_trips')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('trip_date', firstOfMonth);

  if (error) {
    console.warn(`Failed to get trips count for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}

async function getTripsCountByStatus(
  tenantId: string,
  firstOfMonth: string,
  status: string
): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('transport_trips')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', status)
    .gte('trip_date', firstOfMonth);

  if (error) {
    console.warn(`Failed to get ${status} trips for tenant ${tenantId}:`, error.message);
    return 0;
  }

  return count ?? 0;
}
