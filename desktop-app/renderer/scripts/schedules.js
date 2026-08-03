/**
 * Schedules Page Controller
 *
 * Vanilla JS controller for the Schedule Management page.
 * Handles schedule CRUD, trip calendar view, trip generation,
 * and trip cancellation with guardian notification.
 *
 * Requirements: 5.1, 5.5
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var schedules = [];
  var trips = [];
  var routesList = [];
  var vehiclesList = [];
  var driversList = [];
  var editingScheduleId = null;
  var deletingScheduleId = null;
  var cancellingTripId = null;
  var currentWeekStart = getMonday(new Date());

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // Tabs
    tabSchedules: document.getElementById('tab-schedules'),
    tabCalendar: document.getElementById('tab-calendar'),

    // Schedule list view
    scheduleListView: document.getElementById('schedule-list-view'),
    scheduleTableBody: document.getElementById('schedule-table-body'),
    searchInput: document.getElementById('search-input'),
    filterTripType: document.getElementById('filter-trip-type'),
    filterStatus: document.getElementById('filter-status'),
    btnNewSchedule: document.getElementById('btn-new-schedule'),
    btnGenerateTrips: document.getElementById('btn-generate-trips'),

    // Trip calendar view
    tripCalendarView: document.getElementById('trip-calendar-view'),
    tripCalendarGrid: document.getElementById('trip-calendar-grid'),
    weekLabel: document.getElementById('week-label'),
    btnPrevWeek: document.getElementById('btn-prev-week'),
    btnNextWeek: document.getElementById('btn-next-week'),
    btnToday: document.getElementById('btn-today'),
  };

  // Modal elements
  var modalEls = {
    // Schedule form modal
    scheduleModal: document.getElementById('schedule-modal'),
    scheduleModalTitle: document.getElementById('schedule-modal-title'),
    scheduleForm: document.getElementById('schedule-form'),
    scheduleFormError: document.getElementById('schedule-form-error'),
    btnCloseScheduleModal: document.getElementById('btn-close-schedule-modal'),
    btnCancelScheduleForm: document.getElementById('btn-cancel-schedule-form'),
    btnSaveSchedule: document.getElementById('btn-save-schedule'),

    // Cancel trip modal
    cancelTripModal: document.getElementById('cancel-trip-modal'),
    cancelFormError: document.getElementById('cancel-form-error'),
    btnCloseCancelModal: document.getElementById('btn-close-cancel-modal'),
    btnCancelCancelForm: document.getElementById('btn-cancel-cancel-form'),
    btnConfirmCancelTrip: document.getElementById('btn-confirm-cancel-trip'),

    // Delete modal
    deleteModal: document.getElementById('delete-modal'),
    deleteMessage: document.getElementById('delete-message'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete'),
  };

  // ---------------------------------------------------------------------------
  // Service — calls the manage-schedules Edge Function
  // ---------------------------------------------------------------------------

  var SUPABASE_URL = window.phoenixConfig
    ? window.phoenixConfig.supabaseUrl
    : 'https://gktfyhyfbenqnouhsmqe.supabase.co';
  var SUPABASE_KEY = window.phoenixConfig
    ? window.phoenixConfig.supabaseAnonKey
    : '';

  function getAuthHeaders() {
    var token = '';
    try {
      var sessionStr = localStorage.getItem('phoenix-desktop-auth');
      if (sessionStr) {
        var session = JSON.parse(sessionStr);
        token = session.access_token || '';
      }
    } catch (e) { /* ignore */ }
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (token || SUPABASE_KEY),
      'apikey': SUPABASE_KEY,
    };
  }

  async function callManageSchedules(payload) {
    try {
      var response = await fetch(SUPABASE_URL + '/functions/v1/manage-schedules', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      var data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || 'Request failed' };
      }
      return { success: true, data: data };
    } catch (err) {
      return { success: false, error: err.message || 'Network error' };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  function getMonday(date) {
    var d = new Date(date);
    d.setHours(0, 0, 0, 0);
    var day = d.getDay();
    var diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d;
  }

  function formatDate(date) {
    return date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatTime(timeStr) {
    if (!timeStr) return '—';
    var parts = timeStr.split(':');
    var h = parseInt(parts[0], 10);
    var m = parts[1] || '00';
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + ':' + m + ' ' + ampm;
  }

  function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();
  }

  var DAY_LABELS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    loadSchedules();
    loadDropdownData();
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // Tabs
    elements.tabSchedules.addEventListener('click', function () {
      showTab('schedules');
    });
    elements.tabCalendar.addEventListener('click', function () {
      showTab('calendar');
    });

    // Search and filters
    elements.searchInput.addEventListener('input', debounce(handleSearch, 300));
    elements.filterTripType.addEventListener('change', handleFilterChange);
    elements.filterStatus.addEventListener('change', handleFilterChange);

    // New schedule
    elements.btnNewSchedule.addEventListener('click', openNewScheduleForm);

    // Generate trips
    elements.btnGenerateTrips.addEventListener('click', handleGenerateTrips);

    // Week navigation
    elements.btnPrevWeek.addEventListener('click', function () {
      currentWeekStart.setDate(currentWeekStart.getDate() - 7);
      loadTripsForWeek();
    });
    elements.btnNextWeek.addEventListener('click', function () {
      currentWeekStart.setDate(currentWeekStart.getDate() + 7);
      loadTripsForWeek();
    });
    elements.btnToday.addEventListener('click', function () {
      currentWeekStart = getMonday(new Date());
      loadTripsForWeek();
    });

    // Schedule form modal
    modalEls.btnCloseScheduleModal.addEventListener('click', closeScheduleModal);
    modalEls.btnCancelScheduleForm.addEventListener('click', closeScheduleModal);
    modalEls.btnSaveSchedule.addEventListener('click', handleSaveSchedule);

    // Cancel trip modal
    modalEls.btnCloseCancelModal.addEventListener('click', closeCancelTripModal);
    modalEls.btnCancelCancelForm.addEventListener('click', closeCancelTripModal);
    modalEls.btnConfirmCancelTrip.addEventListener('click', handleConfirmCancelTrip);

    // Delete modal
    modalEls.btnCancelDelete.addEventListener('click', closeDeleteModal);
    modalEls.btnConfirmDelete.addEventListener('click', handleConfirmDelete);
  }

  // ---------------------------------------------------------------------------
  // Tab Switching
  // ---------------------------------------------------------------------------

  function showTab(tab) {
    if (tab === 'schedules') {
      elements.tabSchedules.classList.add('active');
      elements.tabCalendar.classList.remove('active');
      elements.scheduleListView.classList.remove('hidden');
      elements.tripCalendarView.classList.add('hidden');
    } else {
      elements.tabCalendar.classList.add('active');
      elements.tabSchedules.classList.remove('active');
      elements.tripCalendarView.classList.remove('hidden');
      elements.scheduleListView.classList.add('hidden');
      loadTripsForWeek();
    }
  }

  // ---------------------------------------------------------------------------
  // Load Dropdown Data (routes, vehicles, drivers)
  // ---------------------------------------------------------------------------

  async function loadDropdownData() {
    await Promise.all([loadRoutes(), loadVehicles(), loadDrivers()]);
  }

  async function loadRoutes() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_routes?select=id,route_name,is_active&is_active=eq.true&order=route_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        routesList = await response.json();
      }
    } catch (err) {
      console.error('Failed to load routes:', err.message);
      routesList = [];
    }
  }

  async function loadVehicles() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_vehicles?select=id,registration_number,status&status=in.(available,assigned)&order=registration_number.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        vehiclesList = await response.json();
      }
    } catch (err) {
      console.error('Failed to load vehicles:', err.message);
      vehiclesList = [];
    }
  }

  async function loadDrivers() {
    try {
      var url = SUPABASE_URL + '/rest/v1/users?select=id,email,raw_user_meta_data&raw_user_meta_data->>role=eq.driver&order=email.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        driversList = await response.json();
      } else {
        // Fallback: try auth.users or alternative query
        driversList = [];
      }
    } catch (err) {
      console.error('Failed to load drivers:', err.message);
      driversList = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Schedule List
  // ---------------------------------------------------------------------------

  async function loadSchedules() {
    var payload = { action: 'list_schedules' };
    var result = await callManageSchedules(payload);

    if (result.success && result.data) {
      schedules = Array.isArray(result.data) ? result.data : (result.data.schedules || []);
      renderScheduleTable(schedules);
    } else {
      await loadSchedulesDirectly();
    }
  }

  async function loadSchedulesDirectly() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_schedules?select=*,' +
        'transport_routes(id,route_name),' +
        'transport_vehicles(id,registration_number),' +
        'users(id,email)' +
        '&order=departure_time.asc';

      var statusVal = elements.filterStatus.value;
      if (statusVal === 'active') url += '&is_active=eq.true';
      if (statusVal === 'inactive') url += '&is_active=eq.false';

      var tripTypeVal = elements.filterTripType.value;
      if (tripTypeVal) url += '&trip_type=eq.' + tripTypeVal;

      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        var data = await response.json();
        schedules = data.map(function (s) {
          return Object.assign({}, s, {
            route_name: s.transport_routes ? s.transport_routes.route_name : '—',
            vehicle_registration: s.transport_vehicles ? s.transport_vehicles.registration_number : '—',
            driver_name: s.users ? s.users.email : '—',
          });
        });
        renderScheduleTable(schedules);
      } else {
        elements.scheduleTableBody.innerHTML =
          '<tr class="empty-row"><td colspan="8">Failed to load schedules.</td></tr>';
      }
    } catch (err) {
      elements.scheduleTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="8">Error: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function handleSearch() {
    var query = elements.searchInput.value.trim().toLowerCase();
    if (!query) {
      renderScheduleTable(schedules);
      return;
    }
    var filtered = schedules.filter(function (s) {
      var routeName = (s.route_name || '').toLowerCase();
      var driverName = (s.driver_name || '').toLowerCase();
      var vehicleReg = (s.vehicle_registration || '').toLowerCase();
      return routeName.indexOf(query) !== -1 ||
        driverName.indexOf(query) !== -1 ||
        vehicleReg.indexOf(query) !== -1;
    });
    renderScheduleTable(filtered);
  }

  function handleFilterChange() {
    loadSchedules();
  }

  function renderScheduleTable(data) {
    if (!data || data.length === 0) {
      elements.scheduleTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="8">No schedules found.</td></tr>';
      return;
    }

    elements.scheduleTableBody.innerHTML = data.map(function (schedule) {
      var statusClass = schedule.is_active ? 'status-active-schedule' : 'status-inactive-schedule';
      var statusLabel = schedule.is_active ? 'Active' : 'Inactive';
      var tripTypeClass = schedule.trip_type === 'morning_pickup' ? 'trip-type-morning' : 'trip-type-afternoon';
      var tripTypeLabel = schedule.trip_type === 'morning_pickup' ? 'Morning' : 'Afternoon';

      var daysHtml = renderDayBadges(schedule.active_days || []);

      return (
        '<tr data-id="' + schedule.id + '">' +
        '<td>' + escapeHtml(schedule.route_name || '—') + '</td>' +
        '<td>' + escapeHtml(schedule.vehicle_registration || '—') + '</td>' +
        '<td>' + escapeHtml(schedule.driver_name || '—') + '</td>' +
        '<td><span class="trip-type-badge ' + tripTypeClass + '">' + tripTypeLabel + '</span></td>' +
        '<td>' + formatTime(schedule.departure_time) + '</td>' +
        '<td>' + daysHtml + '</td>' +
        '<td><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></td>' +
        '<td class="action-links">' +
          '<button class="btn btn-sm btn-secondary btn-edit-schedule" data-id="' + schedule.id + '">Edit</button> ' +
          '<button class="btn btn-sm btn-danger btn-delete-schedule" data-id="' + schedule.id + '">Delete</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('');

    bindScheduleRowEvents();
  }

  function renderDayBadges(activeDays) {
    return DAY_LABELS.map(function (day, i) {
      var isActive = activeDays.indexOf(day) !== -1;
      var cls = isActive ? 'day-badge active-day' : 'day-badge';
      return '<span class="' + cls + '">' + DAY_NAMES[i].charAt(0) + '</span>';
    }).join('');
  }

  function bindScheduleRowEvents() {
    elements.scheduleTableBody.querySelectorAll('.btn-edit-schedule').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        openEditScheduleForm(id);
      });
    });

    elements.scheduleTableBody.querySelectorAll('.btn-delete-schedule').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        openDeleteConfirm(id);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Schedule Form (Create / Edit)
  // ---------------------------------------------------------------------------

  function openNewScheduleForm() {
    editingScheduleId = null;
    modalEls.scheduleModalTitle.textContent = 'New Schedule';
    modalEls.scheduleForm.reset();
    document.getElementById('form-is-active').value = 'true';
    populateDropdowns();
    clearActiveDays();
    hideError(modalEls.scheduleFormError);
    openModal(modalEls.scheduleModal);
  }

  function openEditScheduleForm(scheduleId) {
    var schedule = schedules.find(function (s) { return s.id === scheduleId; });
    if (!schedule) return;

    editingScheduleId = scheduleId;
    modalEls.scheduleModalTitle.textContent = 'Edit Schedule';
    populateDropdowns();

    document.getElementById('form-route').value = schedule.route_id || '';
    document.getElementById('form-vehicle').value = schedule.vehicle_id || '';
    document.getElementById('form-driver').value = schedule.driver_id || '';
    document.getElementById('form-trip-type').value = schedule.trip_type || 'morning_pickup';
    document.getElementById('form-departure-time').value = schedule.departure_time || '';
    document.getElementById('form-is-active').value = schedule.is_active ? 'true' : 'false';

    setActiveDays(schedule.active_days || []);
    hideError(modalEls.scheduleFormError);
    openModal(modalEls.scheduleModal);
  }

  function populateDropdowns() {
    // Routes
    var routeSelect = document.getElementById('form-route');
    routeSelect.innerHTML = '<option value="">Select a route...</option>' +
      routesList.map(function (r) {
        return '<option value="' + r.id + '">' + escapeHtml(r.route_name) + '</option>';
      }).join('');

    // Vehicles
    var vehicleSelect = document.getElementById('form-vehicle');
    vehicleSelect.innerHTML = '<option value="">Select a vehicle...</option>' +
      vehiclesList.map(function (v) {
        return '<option value="' + v.id + '">' + escapeHtml(v.registration_number) + '</option>';
      }).join('');

    // Drivers
    var driverSelect = document.getElementById('form-driver');
    driverSelect.innerHTML = '<option value="">Select a driver...</option>' +
      driversList.map(function (d) {
        var name = d.email || d.id;
        return '<option value="' + d.id + '">' + escapeHtml(name) + '</option>';
      }).join('');
  }

  function getActiveDays() {
    var checkboxes = document.querySelectorAll('#form-active-days input[type="checkbox"]');
    var days = [];
    checkboxes.forEach(function (cb) {
      if (cb.checked) days.push(cb.value);
    });
    return days;
  }

  function setActiveDays(days) {
    var checkboxes = document.querySelectorAll('#form-active-days input[type="checkbox"]');
    checkboxes.forEach(function (cb) {
      cb.checked = days.indexOf(cb.value) !== -1;
    });
  }

  function clearActiveDays() {
    var checkboxes = document.querySelectorAll('#form-active-days input[type="checkbox"]');
    checkboxes.forEach(function (cb) { cb.checked = false; });
  }

  async function handleSaveSchedule() {
    hideError(modalEls.scheduleFormError);

    var routeId = document.getElementById('form-route').value;
    var vehicleId = document.getElementById('form-vehicle').value;
    var driverId = document.getElementById('form-driver').value;
    var tripType = document.getElementById('form-trip-type').value;
    var departureTime = document.getElementById('form-departure-time').value;
    var isActive = document.getElementById('form-is-active').value === 'true';
    var activeDays = getActiveDays();

    // Validation
    if (!routeId) {
      showError(modalEls.scheduleFormError, 'Please select a route.');
      return;
    }
    if (!vehicleId) {
      showError(modalEls.scheduleFormError, 'Please select a vehicle.');
      return;
    }
    if (!driverId) {
      showError(modalEls.scheduleFormError, 'Please select a driver.');
      return;
    }
    if (!departureTime) {
      showError(modalEls.scheduleFormError, 'Departure time is required.');
      return;
    }
    if (activeDays.length === 0) {
      showError(modalEls.scheduleFormError, 'Please select at least one active day.');
      return;
    }

    var payload = {
      action: editingScheduleId ? 'update_schedule' : 'create_schedule',
      route_id: routeId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      trip_type: tripType,
      departure_time: departureTime,
      active_days: activeDays,
      is_active: isActive,
    };
    if (editingScheduleId) payload.schedule_id = editingScheduleId;

    var result = await callManageSchedules(payload);

    if (result.success) {
      closeScheduleModal();
      loadSchedules();
    } else {
      // Fallback: direct Supabase insert/update
      var directResult = await saveScheduleDirect(payload);
      if (directResult.success) {
        closeScheduleModal();
        loadSchedules();
      } else {
        showError(modalEls.scheduleFormError, directResult.error || 'Failed to save schedule.');
      }
    }
  }

  async function saveScheduleDirect(payload) {
    try {
      var user = window.__phoenixServices.getCurrentUser();
      var tenantId = user ? user.tenantId : null;

      if (payload.action === 'create_schedule') {
        var body = {
          route_id: payload.route_id,
          vehicle_id: payload.vehicle_id,
          driver_id: payload.driver_id,
          trip_type: payload.trip_type,
          departure_time: payload.departure_time,
          active_days: payload.active_days,
          is_active: payload.is_active,
        };
        if (tenantId) body.tenant_id = tenantId;

        var response = await fetch(SUPABASE_URL + '/rest/v1/transport_schedules', {
          method: 'POST',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(body),
        });
        if (response.ok) return { success: true, data: await response.json() };
        var errData = await response.json().catch(function () { return {}; });
        return { success: false, error: errData.message || 'Insert failed' };
      } else {
        var updateBody = {
          route_id: payload.route_id,
          vehicle_id: payload.vehicle_id,
          driver_id: payload.driver_id,
          trip_type: payload.trip_type,
          departure_time: payload.departure_time,
          active_days: payload.active_days,
          is_active: payload.is_active,
        };
        var url = SUPABASE_URL + '/rest/v1/transport_schedules?id=eq.' + payload.schedule_id;
        var resp = await fetch(url, {
          method: 'PATCH',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(updateBody),
        });
        if (resp.ok) return { success: true, data: await resp.json() };
        var errBody = await resp.json().catch(function () { return {}; });
        return { success: false, error: errBody.message || 'Update failed' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Trip Generation
  // ---------------------------------------------------------------------------

  async function handleGenerateTrips() {
    var btn = elements.btnGenerateTrips;
    btn.disabled = true;
    btn.textContent = '⟳ Generating...';

    var result = await callManageSchedules({ action: 'generate_trips' });

    btn.disabled = false;
    btn.textContent = '⟳ Generate Trips';

    if (result.success) {
      var count = result.data && result.data.trips_generated ? result.data.trips_generated : 0;
      alert('Trip generation complete. ' + count + ' trip(s) generated.');
      if (elements.tabCalendar.classList.contains('active')) {
        loadTripsForWeek();
      }
    } else {
      alert('Failed to generate trips: ' + (result.error || 'Unknown error'));
    }
  }

  // ---------------------------------------------------------------------------
  // Trip Calendar View
  // ---------------------------------------------------------------------------

  async function loadTripsForWeek() {
    var weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    updateWeekLabel();

    var startStr = currentWeekStart.toISOString().split('T')[0];
    var endStr = weekEnd.toISOString().split('T')[0];

    try {
      var url = SUPABASE_URL + '/rest/v1/transport_trips?select=*,' +
        'transport_routes(route_name),' +
        'transport_vehicles(registration_number)' +
        '&trip_date=gte.' + startStr +
        '&trip_date=lte.' + endStr +
        '&order=trip_date.asc,scheduled_departure.asc';

      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        trips = await response.json();
      } else {
        trips = [];
      }
    } catch (err) {
      console.error('Failed to load trips:', err.message);
      trips = [];
    }

    renderTripCalendar();
  }

  function updateWeekLabel() {
    var weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    elements.weekLabel.textContent = formatDate(currentWeekStart) + ' — ' + formatDate(weekEnd);
  }

  function renderTripCalendar() {
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var html = '';

    // Day headers
    for (var h = 0; h < 7; h++) {
      html += '<div class="calendar-day-header">' + DAY_NAMES[h] + '</div>';
    }

    // Day cells for the week
    for (var d = 0; d < 7; d++) {
      var cellDate = new Date(currentWeekStart);
      cellDate.setDate(cellDate.getDate() + d);

      var isToday = isSameDay(cellDate, today);
      var cellClass = 'calendar-day' + (isToday ? ' today' : '');
      var dateStr = cellDate.toISOString().split('T')[0];

      // Find trips for this day
      var dayTrips = trips.filter(function (t) {
        return t.trip_date === dateStr;
      });

      var tripsHtml = dayTrips.map(function (trip) {
        var routeName = trip.transport_routes ? trip.transport_routes.route_name : 'Trip';
        var label = formatTime(trip.scheduled_departure) + ' ' + routeName;
        var chipClass = 'trip-chip status-' + trip.status;
        return '<span class="' + chipClass + '" data-trip-id="' + trip.id + '" title="' +
          escapeHtml(routeName) + ' - ' + trip.status + '">' +
          escapeHtml(label) + '</span>';
      }).join('');

      html += '<div class="' + cellClass + '">' +
        '<div class="day-number">' + cellDate.getDate() + '</div>' +
        tripsHtml +
        '</div>';
    }

    elements.tripCalendarGrid.innerHTML = html;

    // Bind trip chip click events for cancellation
    elements.tripCalendarGrid.querySelectorAll('.trip-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var tripId = this.getAttribute('data-trip-id');
        var trip = trips.find(function (t) { return t.id === tripId; });
        if (trip && trip.status === 'scheduled') {
          openCancelTripModal(tripId);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Trip Cancellation
  // ---------------------------------------------------------------------------

  function openCancelTripModal(tripId) {
    cancellingTripId = tripId;
    document.getElementById('form-cancel-reason').value = '';
    document.getElementById('form-notify-guardians').checked = true;
    hideError(modalEls.cancelFormError);
    openModal(modalEls.cancelTripModal);
  }

  function closeCancelTripModal() {
    cancellingTripId = null;
    modalEls.cancelTripModal.classList.add('hidden');
  }

  async function handleConfirmCancelTrip() {
    if (!cancellingTripId) return;
    hideError(modalEls.cancelFormError);

    var reason = document.getElementById('form-cancel-reason').value.trim();
    var notifyGuardians = document.getElementById('form-notify-guardians').checked;

    if (!reason) {
      showError(modalEls.cancelFormError, 'Please provide a cancellation reason.');
      return;
    }

    var payload = {
      action: 'cancel_trip',
      trip_id: cancellingTripId,
      cancellation_reason: reason,
      notify_guardians: notifyGuardians,
    };

    var result = await callManageSchedules(payload);

    if (result.success) {
      closeCancelTripModal();
      loadTripsForWeek();
    } else {
      // Fallback: direct update
      var directResult = await cancelTripDirect(cancellingTripId, reason);
      if (directResult.success) {
        closeCancelTripModal();
        loadTripsForWeek();
      } else {
        showError(modalEls.cancelFormError, directResult.error || 'Failed to cancel trip.');
      }
    }
  }

  async function cancelTripDirect(tripId, reason) {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_trips?id=eq.' + tripId;
      var response = await fetch(url, {
        method: 'PATCH',
        headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          status: 'cancelled',
          cancellation_reason: reason,
        }),
      });
      if (response.ok) return { success: true };
      var errData = await response.json().catch(function () { return {}; });
      return { success: false, error: errData.message || 'Cancellation failed' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Schedule
  // ---------------------------------------------------------------------------

  function openDeleteConfirm(scheduleId) {
    deletingScheduleId = scheduleId;
    var schedule = schedules.find(function (s) { return s.id === scheduleId; });
    if (schedule) {
      modalEls.deleteMessage.textContent =
        'Are you sure you want to delete the schedule for "' +
        (schedule.route_name || 'this route') + '" (' +
        formatTime(schedule.departure_time) + ')? This action cannot be undone.';
    }
    openModal(modalEls.deleteModal);
  }

  function closeDeleteModal() {
    deletingScheduleId = null;
    modalEls.deleteModal.classList.add('hidden');
  }

  async function handleConfirmDelete() {
    if (!deletingScheduleId) return;

    var payload = {
      action: 'delete_schedule',
      schedule_id: deletingScheduleId,
    };

    var result = await callManageSchedules(payload);

    if (result.success) {
      closeDeleteModal();
      loadSchedules();
    } else {
      // Fallback: direct delete
      var directResult = await deleteScheduleDirect(deletingScheduleId);
      closeDeleteModal();
      if (directResult.success) {
        loadSchedules();
      } else {
        alert('Failed to delete schedule: ' + (directResult.error || 'Unknown error'));
      }
    }
  }

  async function deleteScheduleDirect(scheduleId) {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_schedules?id=eq.' + scheduleId;
      var response = await fetch(url, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (response.ok || response.status === 204) return { success: true };
      var errData = await response.json().catch(function () { return {}; });
      return { success: false, error: errData.message || 'Delete failed' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Modal Helpers
  // ---------------------------------------------------------------------------

  function openModal(modalEl) {
    modalEl.classList.remove('hidden');
  }

  function closeScheduleModal() {
    editingScheduleId = null;
    modalEls.scheduleModal.classList.add('hidden');
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
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
