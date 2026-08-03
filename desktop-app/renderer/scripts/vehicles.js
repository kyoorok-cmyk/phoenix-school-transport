/**
 * Vehicles Page Controller
 *
 * Vanilla JS controller for the vehicle fleet management page.
 * Wires UI elements to the vehicle service layer for CRUD operations,
 * compliance monitoring, and status display.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var vehicles = [];
  var editingVehicleId = null;
  var deletingVehicleId = null;

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // List view
    vehicleTableBody: document.getElementById('vehicle-table-body'),
    searchInput: document.getElementById('search-input'),
    statusFilter: document.getElementById('status-filter'),
    complianceFilter: document.getElementById('compliance-filter'),
    btnNewVehicle: document.getElementById('btn-new-vehicle'),

    // Stats
    statTotal: document.getElementById('stat-total'),
    statCompliant: document.getElementById('stat-compliant'),
    statExpiring: document.getElementById('stat-expiring'),
    statExpired: document.getElementById('stat-expired'),

    // Form modal
    vehicleModal: document.getElementById('vehicle-modal'),
    vehicleModalTitle: document.getElementById('vehicle-modal-title'),
    vehicleForm: document.getElementById('vehicle-form'),
    formError: document.getElementById('form-error'),
    formExpiryInfo: document.getElementById('form-expiry-info'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCancelForm: document.getElementById('btn-cancel-form'),

    // Delete modal
    deleteModal: document.getElementById('delete-modal'),
    deleteWarning: document.getElementById('delete-warning'),
    deleteWarningText: document.getElementById('delete-warning-text'),
    deleteMessage: document.getElementById('delete-message'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete'),
  };

  // ---------------------------------------------------------------------------
  // Service Interface
  // ---------------------------------------------------------------------------

  var services = window.__phoenixServices || {};

  /**
   * Vehicle service methods (wired via bundler or fallback stubs).
   */
  var vehicleService = {
    getVehicles: services.getVehicles || async function (filters) {
      // Fallback: direct Supabase query
      if (!window.phoenixConfig) return { success: true, data: [] };
      try {
        var supabaseUrl = window.phoenixConfig.supabaseUrl;
        var supabaseKey = window.phoenixConfig.supabaseAnonKey;
        var url = supabaseUrl + '/rest/v1/transport_vehicles?select=*&order=registration_number.asc';

        if (filters && filters.status) {
          url += '&status=eq.' + filters.status;
        }
        if (filters && filters.search) {
          url += '&or=(registration_number.ilike.*' + filters.search + '*,make.ilike.*' + filters.search + '*,model.ilike.*' + filters.search + '*)';
        }

        var response = await fetch(url, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
          },
        });
        var data = await response.json();
        var enriched = (data || []).map(function (v) { return enrichVehicle(v); });

        if (filters && filters.compliance_status) {
          enriched = enriched.filter(function (v) { return v.compliance_status === filters.compliance_status; });
        }

        return { success: true, data: enriched };
      } catch (e) {
        return { success: false, error: 'Failed to fetch vehicles' };
      }
    },

    createVehicle: services.createVehicle || async function (data) {
      if (!window.phoenixConfig) return { success: false, error: 'Service not connected' };
      try {
        var supabaseUrl = window.phoenixConfig.supabaseUrl;
        var supabaseKey = window.phoenixConfig.supabaseAnonKey;
        var response = await fetch(supabaseUrl + '/functions/v1/manage-vehicles', {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'create', vehicle: data }),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true, data: enrichVehicle(result.vehicle || result.data || result) };
      } catch (e) {
        return { success: false, error: 'Failed to create vehicle' };
      }
    },

    updateVehicle: services.updateVehicle || async function (id, data) {
      if (!window.phoenixConfig) return { success: false, error: 'Service not connected' };
      try {
        var supabaseUrl = window.phoenixConfig.supabaseUrl;
        var supabaseKey = window.phoenixConfig.supabaseAnonKey;
        var response = await fetch(supabaseUrl + '/functions/v1/manage-vehicles', {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'update', vehicleId: id, vehicle: data }),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true, data: enrichVehicle(result.vehicle || result.data || result) };
      } catch (e) {
        return { success: false, error: 'Failed to update vehicle' };
      }
    },

    deleteVehicle: services.deleteVehicle || async function (id) {
      if (!window.phoenixConfig) return { success: false, error: 'Service not connected' };
      try {
        var supabaseUrl = window.phoenixConfig.supabaseUrl;
        var supabaseKey = window.phoenixConfig.supabaseAnonKey;
        var response = await fetch(supabaseUrl + '/functions/v1/manage-vehicles', {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'delete', vehicleId: id }),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true };
      } catch (e) {
        return { success: false, error: 'Failed to delete vehicle' };
      }
    },

    checkVehicleInUse: services.checkVehicleInUse || async function (vehicleId) {
      if (!window.phoenixConfig) return { success: true, data: { in_use: false, trip_count: 0 } };
      try {
        var supabaseUrl = window.phoenixConfig.supabaseUrl;
        var supabaseKey = window.phoenixConfig.supabaseAnonKey;
        var url = supabaseUrl + '/rest/v1/transport_trips?select=id&vehicle_id=eq.' + vehicleId + '&status=in.(scheduled,in_progress)';

        var response = await fetch(url, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'count=exact',
          },
        });
        var contentRange = response.headers.get('content-range');
        var count = 0;
        if (contentRange) {
          var parts = contentRange.split('/');
          count = parseInt(parts[1], 10) || 0;
        } else {
          var data = await response.json();
          count = (data || []).length;
        }
        return { success: true, data: { in_use: count > 0, trip_count: count } };
      } catch (e) {
        return { success: true, data: { in_use: false, trip_count: 0 } };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function enrichVehicle(vehicle) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var expiry = new Date(vehicle.compliance_certificate_expiry);
    expiry.setHours(0, 0, 0, 0);

    var diffMs = expiry.getTime() - today.getTime();
    var daysUntilExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    var complianceStatus;
    if (daysUntilExpiry < 0) {
      complianceStatus = 'expired';
    } else if (daysUntilExpiry <= 30) {
      complianceStatus = 'expiring_soon';
    } else {
      complianceStatus = 'valid';
    }

    return Object.assign({}, vehicle, {
      compliance_status: complianceStatus,
      days_until_expiry: daysUntilExpiry,
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function debounce(fn, delay) {
    var timer;
    return function () {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(context, args); }, delay);
    };
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function getComplianceBadgeHtml(vehicle) {
    var cls, label;
    if (vehicle.compliance_status === 'expired') {
      cls = 'compliance-expired';
      label = 'Expired';
    } else if (vehicle.compliance_status === 'expiring_soon') {
      cls = 'compliance-expiring';
      label = vehicle.days_until_expiry + 'd left';
    } else {
      cls = 'compliance-valid';
      label = 'Valid';
    }
    return '<span class="compliance-badge ' + cls + '">' + label + '</span>';
  }

  function getAssignmentBadgeHtml(status) {
    var cls = 'assignment-' + status;
    var label = status.charAt(0).toUpperCase() + status.slice(1);
    return '<span class="assignment-badge ' + cls + '">' + label + '</span>';
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    loadVehicles();
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // Search and filters
    elements.searchInput.addEventListener('input', debounce(handleFilterChange, 300));
    elements.statusFilter.addEventListener('change', handleFilterChange);
    elements.complianceFilter.addEventListener('change', handleFilterChange);

    // New vehicle
    elements.btnNewVehicle.addEventListener('click', openNewVehicleForm);

    // Form modal
    elements.btnCloseModal.addEventListener('click', closeModal);
    elements.btnCancelForm.addEventListener('click', closeModal);
    elements.vehicleForm.addEventListener('submit', handleFormSubmit);

    // Expiry date change → show compliance info
    document.getElementById('form-expiry').addEventListener('change', updateExpiryInfo);

    // Delete modal
    elements.btnCancelDelete.addEventListener('click', closeDeleteModal);
    elements.btnConfirmDelete.addEventListener('click', handleConfirmDelete);
  }

  // ---------------------------------------------------------------------------
  // Load & Render
  // ---------------------------------------------------------------------------

  async function loadVehicles() {
    var filters = getFilters();
    var result = await vehicleService.getVehicles(filters);

    if (result.success) {
      vehicles = result.data || [];
      renderVehicleTable(vehicles);
      updateStats(vehicles);
    } else {
      elements.vehicleTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="8">Failed to load vehicles.</td></tr>';
    }
  }

  function getFilters() {
    var filters = {};
    var search = elements.searchInput.value.trim();
    var status = elements.statusFilter.value;
    var compliance = elements.complianceFilter.value;

    if (search) filters.search = search;
    if (status) filters.status = status;
    if (compliance) filters.compliance_status = compliance;

    return filters;
  }

  function handleFilterChange() {
    loadVehicles();
  }

  function updateStats(data) {
    var total = data.length;
    var compliant = data.filter(function (v) { return v.compliance_status === 'valid'; }).length;
    var expiring = data.filter(function (v) { return v.compliance_status === 'expiring_soon'; }).length;
    var expired = data.filter(function (v) { return v.compliance_status === 'expired'; }).length;

    elements.statTotal.textContent = total;
    elements.statCompliant.textContent = compliant;
    elements.statExpiring.textContent = expiring;
    elements.statExpired.textContent = expired;
  }

  function renderVehicleTable(data) {
    if (!data || data.length === 0) {
      elements.vehicleTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="8">No vehicles found.</td></tr>';
      return;
    }

    elements.vehicleTableBody.innerHTML = data.map(function (vehicle) {
      return (
        '<tr data-id="' + vehicle.id + '">' +
        '<td class="reg-number">' + escapeHtml(vehicle.registration_number) + '</td>' +
        '<td>' + escapeHtml(vehicle.make) + '</td>' +
        '<td>' + escapeHtml(vehicle.model) + '</td>' +
        '<td class="vehicle-year">' + vehicle.year + '</td>' +
        '<td class="capacity-cell">' + vehicle.seating_capacity + '</td>' +
        '<td>' + getComplianceBadgeHtml(vehicle) + '</td>' +
        '<td>' + getAssignmentBadgeHtml(vehicle.status) + '</td>' +
        '<td class="action-links">' +
          '<button class="btn btn-sm btn-secondary btn-edit-vehicle" data-id="' + vehicle.id + '">Edit</button> ' +
          '<button class="btn btn-sm btn-danger btn-delete-vehicle" data-id="' + vehicle.id + '">Delete</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('');

    // Bind action buttons
    elements.vehicleTableBody.querySelectorAll('.btn-edit-vehicle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        openEditVehicleForm(id);
      });
    });

    elements.vehicleTableBody.querySelectorAll('.btn-delete-vehicle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        openDeleteConfirm(id);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Vehicle Form (Create / Edit)
  // ---------------------------------------------------------------------------

  function openNewVehicleForm() {
    editingVehicleId = null;
    elements.vehicleModalTitle.textContent = 'Add Vehicle';
    elements.vehicleForm.reset();
    clearExpiryInfo();
    hideFormError();
    openModal();
  }

  function openEditVehicleForm(vehicleId) {
    var vehicle = vehicles.find(function (v) { return v.id === vehicleId; });
    if (!vehicle) return;

    editingVehicleId = vehicleId;
    elements.vehicleModalTitle.textContent = 'Edit Vehicle';

    document.getElementById('form-reg-number').value = vehicle.registration_number || '';
    document.getElementById('form-make').value = vehicle.make || '';
    document.getElementById('form-model').value = vehicle.model || '';
    document.getElementById('form-year').value = vehicle.year || '';
    document.getElementById('form-capacity').value = vehicle.seating_capacity || '';
    document.getElementById('form-expiry').value = vehicle.compliance_certificate_expiry || '';

    updateExpiryInfo();
    hideFormError();
    openModal();
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    hideFormError();

    var data = {
      registration_number: document.getElementById('form-reg-number').value.trim(),
      make: document.getElementById('form-make').value.trim(),
      model: document.getElementById('form-model').value.trim(),
      year: parseInt(document.getElementById('form-year').value, 10),
      seating_capacity: parseInt(document.getElementById('form-capacity').value, 10),
      compliance_certificate_expiry: document.getElementById('form-expiry').value,
    };

    // Client-side validation
    if (!data.registration_number) {
      showFormError('Registration number is required.');
      return;
    }
    if (!data.make) {
      showFormError('Make is required.');
      return;
    }
    if (!data.model) {
      showFormError('Model is required.');
      return;
    }
    if (isNaN(data.year) || data.year < 1990 || data.year > 2100) {
      showFormError('Year must be between 1990 and 2100.');
      return;
    }
    if (isNaN(data.seating_capacity) || data.seating_capacity < 1 || data.seating_capacity > 100) {
      showFormError('Seating capacity must be between 1 and 100.');
      return;
    }
    if (!data.compliance_certificate_expiry) {
      showFormError('Compliance certificate expiry date is required.');
      return;
    }

    var result;
    if (editingVehicleId) {
      result = await vehicleService.updateVehicle(editingVehicleId, data);
    } else {
      result = await vehicleService.createVehicle(data);
    }

    if (result.success) {
      closeModal();
      loadVehicles();
    } else {
      showFormError(result.error || 'Failed to save vehicle.');
    }
  }

  // ---------------------------------------------------------------------------
  // Expiry Info
  // ---------------------------------------------------------------------------

  function updateExpiryInfo() {
    var expiryInput = document.getElementById('form-expiry');
    var value = expiryInput.value;
    if (!value) {
      clearExpiryInfo();
      return;
    }

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var expiry = new Date(value);
    expiry.setHours(0, 0, 0, 0);
    var diffMs = expiry.getTime() - today.getTime();
    var days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    var infoEl = elements.formExpiryInfo;
    if (days < 0) {
      infoEl.textContent = '⚠️ Expired ' + Math.abs(days) + ' days ago';
      infoEl.className = 'expiry-info info-expired';
    } else if (days <= 30) {
      infoEl.textContent = '⚠️ Expires in ' + days + ' days';
      infoEl.className = 'expiry-info info-warning';
    } else {
      infoEl.textContent = '✓ Valid for ' + days + ' days';
      infoEl.className = 'expiry-info info-valid';
    }
  }

  function clearExpiryInfo() {
    elements.formExpiryInfo.textContent = '';
    elements.formExpiryInfo.className = 'expiry-info';
  }

  // ---------------------------------------------------------------------------
  // Delete Vehicle
  // ---------------------------------------------------------------------------

  async function openDeleteConfirm(vehicleId) {
    deletingVehicleId = vehicleId;

    // Check if vehicle is in use
    var usageResult = await vehicleService.checkVehicleInUse(vehicleId);
    if (usageResult.success && usageResult.data && usageResult.data.in_use) {
      elements.deleteWarning.classList.remove('hidden');
      elements.deleteWarningText.textContent =
        'This vehicle is assigned to ' + usageResult.data.trip_count +
        ' active/scheduled trip(s). Deletion may be blocked by the system.';
    } else {
      elements.deleteWarning.classList.add('hidden');
    }

    var vehicle = vehicles.find(function (v) { return v.id === vehicleId; });
    if (vehicle) {
      elements.deleteMessage.textContent =
        'Are you sure you want to delete vehicle "' + vehicle.registration_number +
        '" (' + vehicle.make + ' ' + vehicle.model + ')? This action cannot be undone.';
    }

    elements.deleteModal.classList.remove('hidden');
  }

  function closeDeleteModal() {
    deletingVehicleId = null;
    elements.deleteModal.classList.add('hidden');
    elements.deleteWarning.classList.add('hidden');
  }

  async function handleConfirmDelete() {
    if (!deletingVehicleId) return;

    var result = await vehicleService.deleteVehicle(deletingVehicleId);
    closeDeleteModal();

    if (result.success) {
      loadVehicles();
    } else {
      alert('Failed to delete vehicle: ' + (result.error || 'Unknown error'));
    }
  }

  // ---------------------------------------------------------------------------
  // Modal Helpers
  // ---------------------------------------------------------------------------

  function openModal() {
    elements.vehicleModal.classList.remove('hidden');
  }

  function closeModal() {
    elements.vehicleModal.classList.add('hidden');
    editingVehicleId = null;
  }

  function showFormError(msg) {
    elements.formError.textContent = msg;
    elements.formError.classList.remove('hidden');
  }

  function hideFormError() {
    elements.formError.textContent = '';
    elements.formError.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Initialize on DOM ready
  // ---------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
