/**
 * Vehicle Service — CRUD operations for transport vehicles via the
 * `manage-vehicles` Edge Function.
 *
 * All queries are scoped to the authenticated user's tenant via RLS.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import { supabase } from './supabase-client';
import { computeComplianceStatus, ComplianceStatus } from './vehicle-compliance';

// Re-export for consumers
export { computeComplianceStatus } from './vehicle-compliance';
export type { ComplianceStatus } from './vehicle-compliance';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VehicleStatus = 'available' | 'assigned' | 'maintenance' | 'decommissioned';

export interface Vehicle {
  id: string;
  tenant_id: string;
  registration_number: string;
  make: string;
  model: string;
  year: number;
  seating_capacity: number;
  compliance_certificate_expiry: string; // ISO date string
  status: VehicleStatus;
  created_at: string;
  updated_at: string;
}

export interface VehicleWithCompliance extends Vehicle {
  compliance_status: ComplianceStatus;
  days_until_expiry: number;
}

export interface CreateVehicleData {
  registration_number: string;
  make: string;
  model: string;
  year: number;
  seating_capacity: number;
  compliance_certificate_expiry: string;
}

export interface UpdateVehicleData {
  registration_number?: string;
  make?: string;
  model?: string;
  year?: number;
  seating_capacity?: number;
  compliance_certificate_expiry?: string;
  status?: VehicleStatus;
}

export interface VehicleFilters {
  status?: VehicleStatus;
  compliance_status?: ComplianceStatus;
  search?: string;
}

export interface VehicleServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enrich a vehicle record with computed compliance status.
 */
function enrichVehicle(vehicle: Vehicle): VehicleWithCompliance {
  const { compliance_status, days_until_expiry } = computeComplianceStatus(
    vehicle.compliance_certificate_expiry
  );
  return { ...vehicle, compliance_status, days_until_expiry };
}

// ---------------------------------------------------------------------------
// Service Methods
// ---------------------------------------------------------------------------

/**
 * Fetch all vehicles for the current tenant with optional filters.
 */
export async function getVehicles(
  filters?: VehicleFilters
): Promise<VehicleServiceResult<VehicleWithCompliance[]>> {
  try {
    let query = supabase
      .from('transport_vehicles')
      .select('*')
      .order('registration_number', { ascending: true });

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    if (filters?.search) {
      const term = `%${filters.search}%`;
      query = query.or(
        `registration_number.ilike.${term},make.ilike.${term},model.ilike.${term}`
      );
    }

    const { data, error } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    let vehicles = (data as Vehicle[]).map(enrichVehicle);

    // Client-side compliance filter (since it's computed)
    if (filters?.compliance_status) {
      vehicles = vehicles.filter(
        (v) => v.compliance_status === filters.compliance_status
      );
    }

    return { success: true, data: vehicles };
  } catch (err) {
    return { success: false, error: 'Failed to fetch vehicles' };
  }
}

/**
 * Fetch a single vehicle by ID.
 */
export async function getVehicleById(
  id: string
): Promise<VehicleServiceResult<VehicleWithCompliance>> {
  try {
    const { data, error } = await supabase
      .from('transport_vehicles')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: enrichVehicle(data as Vehicle) };
  } catch (err) {
    return { success: false, error: 'Failed to fetch vehicle' };
  }
}

/**
 * Create a new vehicle via the manage-vehicles Edge Function.
 */
export async function createVehicle(
  data: CreateVehicleData
): Promise<VehicleServiceResult<VehicleWithCompliance>> {
  try {
    // Validate required fields
    if (!data.registration_number?.trim()) {
      return { success: false, error: 'Registration number is required' };
    }
    if (!data.make?.trim()) {
      return { success: false, error: 'Make is required' };
    }
    if (!data.model?.trim()) {
      return { success: false, error: 'Model is required' };
    }
    if (!data.year || data.year < 1990 || data.year > 2100) {
      return { success: false, error: 'Year must be between 1990 and 2100' };
    }
    if (!data.seating_capacity || data.seating_capacity < 1 || data.seating_capacity > 100) {
      return { success: false, error: 'Seating capacity must be between 1 and 100' };
    }
    if (!data.compliance_certificate_expiry) {
      return { success: false, error: 'Compliance certificate expiry date is required' };
    }

    const { data: result, error } = await supabase.functions.invoke('manage-vehicles', {
      body: { action: 'create', vehicle: data },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (result?.error) {
      return { success: false, error: result.error };
    }

    return { success: true, data: enrichVehicle(result.vehicle || result.data) };
  } catch (err) {
    return { success: false, error: 'Failed to create vehicle' };
  }
}

/**
 * Update an existing vehicle via the manage-vehicles Edge Function.
 */
export async function updateVehicle(
  id: string,
  data: UpdateVehicleData
): Promise<VehicleServiceResult<VehicleWithCompliance>> {
  try {
    const { data: result, error } = await supabase.functions.invoke('manage-vehicles', {
      body: { action: 'update', vehicleId: id, vehicle: data },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (result?.error) {
      return { success: false, error: result.error };
    }

    return { success: true, data: enrichVehicle(result.vehicle || result.data) };
  } catch (err) {
    return { success: false, error: 'Failed to update vehicle' };
  }
}

/**
 * Delete a vehicle via the manage-vehicles Edge Function.
 * Will fail if the vehicle is assigned to an in-progress trip.
 */
export async function deleteVehicle(
  id: string
): Promise<VehicleServiceResult<void>> {
  try {
    const { data: result, error } = await supabase.functions.invoke('manage-vehicles', {
      body: { action: 'delete', vehicleId: id },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (result?.error) {
      return { success: false, error: result.error };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: 'Failed to delete vehicle' };
  }
}

/**
 * Check if a vehicle is currently in use (assigned to active trips).
 */
export async function checkVehicleInUse(
  vehicleId: string
): Promise<VehicleServiceResult<{ in_use: boolean; trip_count: number }>> {
  try {
    const { data, error, count } = await supabase
      .from('transport_trips')
      .select('id', { count: 'exact', head: true })
      .eq('vehicle_id', vehicleId)
      .in('status', ['scheduled', 'in_progress']);

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      data: { in_use: (count ?? 0) > 0, trip_count: count ?? 0 },
    };
  } catch (err) {
    return { success: false, error: 'Failed to check vehicle usage' };
  }
}
