/**
 * Supabase Bundle for Electron Renderer
 * 
 * This script initializes the Supabase client and wires all transport service
 * functions to the window.__phoenixServices object that page scripts use.
 * 
 * Loaded via a script tag on every page AFTER init.js.
 * Uses dynamic import from CDN to load the Supabase SDK.
 */
(async function () {
  'use strict';

  var config = window.phoenixConfig || {};
  var SUPABASE_URL = config.supabaseUrl || 'https://crkivsdsrdbseawfgxzf.supabase.co';
  var SUPABASE_KEY = config.supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNya2l2c2RzcmRic2Vhd2ZneHpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MDA3ODAsImV4cCI6MjEwMTE3Njc4MH0.KnUqw_DicnHX-_cDGPAoSjYQEogYXTz-H2PTf4hlDU4';

  var supabase = null;

  try {
    var module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabase = module.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    console.log('[supabase-bundle] Supabase client initialized');

    // Restore session from localStorage
    var storedSession = localStorage.getItem('phoenix-desktop-auth');
    if (storedSession) {
      try {
        var sessionData = JSON.parse(storedSession);
        if (sessionData.access_token && sessionData.refresh_token) {
          var result = await supabase.auth.setSession({
            access_token: sessionData.access_token,
            refresh_token: sessionData.refresh_token,
          });
          if (result.data.session) {
            console.log('[supabase-bundle] Session restored for:', result.data.session.user.email);
            // Update stored tokens in case they were refreshed
            localStorage.setItem('phoenix-desktop-auth', JSON.stringify({
              access_token: result.data.session.access_token,
              refresh_token: result.data.session.refresh_token,
              user: sessionData.user,
            }));
          } else {
            console.warn('[supabase-bundle] Session restoration failed, stored tokens may be expired');
          }
        }
      } catch (e) {
        console.warn('[supabase-bundle] Failed to restore session:', e.message);
      }
    }
  } catch (err) {
    console.error('[supabase-bundle] Failed to load Supabase SDK:', err);
    return;
  }

  // Get current user info from localStorage
  function getCurrentUser() {
    try {
      var stored = localStorage.getItem('phoenix-desktop-auth');
      if (!stored) return null;
      var session = JSON.parse(stored);
      return session.user || null;
    } catch (e) { return null; }
  }

  // Get tenant_id for current user
  function getTenantId() {
    var user = getCurrentUser();
    return user ? user.tenant_id : null;
  }

  // --- VEHICLE SERVICE ---
  async function getVehicles(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_vehicles').select('*').order('created_at', { ascending: false });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.status) query = query.eq('status', filters.status);
      if (filters && filters.search) query = query.or('registration_number.ilike.%' + filters.search + '%,make.ilike.%' + filters.search + '%,model.ilike.%' + filters.search + '%');
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch vehicles' };
    }
  }

  async function createVehicle(data) {
    try {
      var tenantId = getTenantId();
      if (tenantId) data.tenant_id = tenantId;
      var result = await supabase.from('transport_vehicles').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to create vehicle' };
    }
  }

  async function updateVehicle(id, data) {
    try {
      var result = await supabase.from('transport_vehicles').update(data).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to update vehicle' };
    }
  }

  async function deleteVehicle(id) {
    try {
      var result = await supabase.from('transport_vehicles').delete().eq('id', id);
      if (result.error) return { success: false, error: result.error.message };
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to delete vehicle' };
    }
  }

  // --- ROUTE SERVICE ---
  async function getRoutes(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_routes').select('*').order('route_name', { ascending: true });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.status === 'active') query = query.eq('is_active', true);
      if (filters && filters.status === 'inactive') query = query.eq('is_active', false);
      if (filters && filters.search) query = query.ilike('route_name', '%' + filters.search + '%');
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch routes' };
    }
  }

  async function createRoute(data) {
    try {
      var tenantId = getTenantId();
      if (tenantId) data.tenant_id = tenantId;
      var result = await supabase.from('transport_routes').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to create route' };
    }
  }

  async function updateRoute(id, data) {
    try {
      var result = await supabase.from('transport_routes').update(data).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to update route' };
    }
  }

  async function deleteRoute(id) {
    try {
      var result = await supabase.from('transport_routes').delete().eq('id', id);
      if (result.error) return { success: false, error: result.error.message };
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to delete route' };
    }
  }

  // --- ROUTE STOPS ---
  async function getRouteStops(routeId) {
    try {
      var result = await supabase.from('transport_route_stops').select('*').eq('route_id', routeId).order('stop_order', { ascending: true });
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch stops' };
    }
  }

  async function createRouteStop(data) {
    try {
      var result = await supabase.from('transport_route_stops').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to create stop' };
    }
  }

  async function updateRouteStop(id, data) {
    try {
      var result = await supabase.from('transport_route_stops').update(data).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to update stop' };
    }
  }

  async function deleteRouteStop(id) {
    try {
      var result = await supabase.from('transport_route_stops').delete().eq('id', id);
      if (result.error) return { success: false, error: result.error.message };
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to delete stop' };
    }
  }

  // --- STUDENT SERVICE ---
  async function getStudents(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_students').select('*, transport_routes(route_name), transport_route_stops(stop_name)').order('full_name', { ascending: true });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.status) query = query.eq('status', filters.status);
      if (filters && filters.route_id) query = query.eq('route_id', filters.route_id);
      if (filters && filters.search) query = query.or('full_name.ilike.%' + filters.search + '%,school_name.ilike.%' + filters.search + '%');
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch students' };
    }
  }

  async function createStudent(data) {
    try {
      var tenantId = getTenantId();
      if (tenantId) data.tenant_id = tenantId;
      var result = await supabase.from('transport_students').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to create student' };
    }
  }

  async function updateStudent(id, data) {
    try {
      var result = await supabase.from('transport_students').update(data).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to update student' };
    }
  }

  async function deleteStudent(id) {
    try {
      var result = await supabase.from('transport_students').update({ status: 'removed' }).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to remove student' };
    }
  }

  // --- GUARDIAN SERVICE ---
  async function getGuardians(studentId) {
    try {
      var result = await supabase.from('transport_guardians').select('*').eq('student_id', studentId).order('is_primary', { ascending: false });
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch guardians' };
    }
  }

  async function saveGuardians(studentId, guardians) {
    try {
      // Delete existing guardians
      await supabase.from('transport_guardians').delete().eq('student_id', studentId);
      // Insert new ones
      if (guardians.length > 0) {
        var toInsert = guardians.map(function(g) { return { ...g, student_id: studentId }; });
        var result = await supabase.from('transport_guardians').insert(toInsert);
        if (result.error) return { success: false, error: result.error.message };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to save guardians' };
    }
  }

  // --- SCHEDULE SERVICE ---
  async function getSchedules(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_schedules').select('*, transport_routes(route_name), transport_vehicles(registration_number)').order('departure_time', { ascending: true });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.trip_type) query = query.eq('trip_type', filters.trip_type);
      if (filters && filters.is_active !== undefined) query = query.eq('is_active', filters.is_active);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch schedules' };
    }
  }

  async function createSchedule(data) {
    try {
      var tenantId = getTenantId();
      if (tenantId) data.tenant_id = tenantId;
      var result = await supabase.from('transport_schedules').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to create schedule' };
    }
  }

  async function updateSchedule(id, data) {
    try {
      var result = await supabase.from('transport_schedules').update(data).eq('id', id).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to update schedule' };
    }
  }

  async function deleteSchedule(id) {
    try {
      var result = await supabase.from('transport_schedules').delete().eq('id', id);
      if (result.error) return { success: false, error: result.error.message };
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to delete schedule' };
    }
  }

  // --- TRIP SERVICE ---
  async function getTrips(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_trips').select('*, transport_routes(route_name), transport_vehicles(registration_number)').order('trip_date', { ascending: false });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.status) query = query.eq('status', filters.status);
      if (filters && filters.date_from) query = query.gte('trip_date', filters.date_from);
      if (filters && filters.date_to) query = query.lte('trip_date', filters.date_to);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch trips' };
    }
  }

  async function getActiveTrips() {
    try {
      var tenantId = getTenantId();
      var today = new Date().toISOString().split('T')[0];
      var query = supabase.from('transport_trips').select('*, transport_routes(route_name), transport_vehicles(registration_number)').eq('trip_date', today).in('status', ['scheduled', 'in_progress']);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch active trips' };
    }
  }

  // --- INVOICE SERVICE ---
  async function getInvoices(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_invoices').select('*, transport_students(full_name), transport_routes(route_name)').order('created_at', { ascending: false });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.status) query = query.eq('status', filters.status);
      if (filters && filters.billing_month) query = query.eq('billing_month', filters.billing_month);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch invoices' };
    }
  }

  // --- PAYMENT SERVICE ---
  async function recordPayment(data) {
    try {
      var tenantId = getTenantId();
      if (tenantId) data.tenant_id = tenantId;
      var result = await supabase.from('transport_payments').insert(data).select().single();
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to record payment' };
    }
  }

  // --- AUDIT LOG ---
  async function getAuditLog(filters) {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_audit_log').select('*').order('created_at', { ascending: false }).limit(filters && filters.limit || 50);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (filters && filters.event_type) query = query.eq('event_type', filters.event_type);
      if (filters && filters.entity_type) query = query.eq('entity_type', filters.entity_type);
      if (filters && filters.user_id) query = query.eq('user_id', filters.user_id);
      if (filters && filters.date_from) query = query.gte('created_at', filters.date_from);
      if (filters && filters.date_to) query = query.lte('created_at', filters.date_to + 'T23:59:59');
      if (filters && filters.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch audit log' };
    }
  }

  // --- GPS LOCATIONS (for live tracking) ---
  async function getLatestLocations() {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_gps_locations').select('*, transport_vehicles(registration_number)').order('recorded_at', { ascending: false }).limit(100);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch locations' };
    }
  }

  // --- DRIVERS (for schedule assignment) ---
  async function getDrivers() {
    try {
      var tenantId = getTenantId();
      var query = supabase.from('transport_drivers').select('*').order('full_name', { ascending: true });
      if (tenantId) query = query.eq('tenant_id', tenantId);
      var result = await query;
      if (result.error) return { success: false, error: result.error.message };
      return { success: true, data: result.data || [] };
    } catch (e) {
      return { success: false, error: e.message || 'Failed to fetch drivers' };
    }
  }

  // --- EXPOSE ALL SERVICES ---
  window.__phoenixServices = {
    getCurrentUser: getCurrentUser,
    getTenantId: getTenantId,
    // Vehicles
    getVehicles: getVehicles,
    createVehicle: createVehicle,
    updateVehicle: updateVehicle,
    deleteVehicle: deleteVehicle,
    // Routes
    getRoutes: getRoutes,
    createRoute: createRoute,
    updateRoute: updateRoute,
    deleteRoute: deleteRoute,
    getRouteStops: getRouteStops,
    createRouteStop: createRouteStop,
    updateRouteStop: updateRouteStop,
    deleteRouteStop: deleteRouteStop,
    // Students
    getStudents: getStudents,
    createStudent: createStudent,
    updateStudent: updateStudent,
    deleteStudent: deleteStudent,
    getGuardians: getGuardians,
    saveGuardians: saveGuardians,
    // Schedules
    getSchedules: getSchedules,
    createSchedule: createSchedule,
    updateSchedule: updateSchedule,
    deleteSchedule: deleteSchedule,
    // Trips
    getTrips: getTrips,
    getActiveTrips: getActiveTrips,
    // Billing
    getInvoices: getInvoices,
    recordPayment: recordPayment,
    // Audit
    getAuditLog: getAuditLog,
    // Tracking
    getLatestLocations: getLatestLocations,
    // Drivers
    getDrivers: getDrivers,
  };

  // Expose Supabase client for Realtime channel usage (e.g. live tracking)
  window.__supabaseClient = supabase;

  console.log('[supabase-bundle] All transport services wired to window.__phoenixServices');

  // Signal that services are ready — page scripts wait for this event
  window.__phoenixServicesReady = true;
  window.dispatchEvent(new Event('phoenixServicesReady'));
})();
