/**
 * Students Page Controller
 *
 * Vanilla JS controller for the Student Management page.
 * Handles student CRUD, guardian management, route/stop assignment,
 * and validation feedback for capacity and stop-route constraints.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var students = [];
  var routes = [];
  var schools = [];
  var routeStopsCache = {}; // { routeId: [stops] }
  var editingStudentId = null;
  var deletingStudentId = null;
  var guardianCounter = 0;

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // List view
    studentTableBody: document.getElementById('student-table-body'),
    searchInput: document.getElementById('search-input'),
    statusFilter: document.getElementById('status-filter'),
    routeFilter: document.getElementById('route-filter'),
    btnNewStudent: document.getElementById('btn-new-student'),

    // Stats
    statTotal: document.getElementById('stat-total'),
    statActive: document.getElementById('stat-active'),
    statSuspended: document.getElementById('stat-suspended'),
    statRemoved: document.getElementById('stat-removed'),

    // Form modal
    studentModal: document.getElementById('student-modal'),
    studentModalTitle: document.getElementById('student-modal-title'),
    studentForm: document.getElementById('student-form'),
    formError: document.getElementById('form-error'),
    capacityInfo: document.getElementById('capacity-info'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCancelForm: document.getElementById('btn-cancel-form'),
    btnSaveStudent: document.getElementById('btn-save-student'),
    btnAddGuardian: document.getElementById('btn-add-guardian'),
    guardiansContainer: document.getElementById('guardians-container'),
    formRoute: document.getElementById('form-route'),
    formStop: document.getElementById('form-stop'),

    // Delete modal
    deleteModal: document.getElementById('delete-modal'),
    deleteMessage: document.getElementById('delete-message'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete'),
  };

  // ---------------------------------------------------------------------------
  // Service — calls the manage-students Edge Function
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

  async function callManageStudents(payload) {
    try {
      var response = await fetch(SUPABASE_URL + '/functions/v1/manage-students', {
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

  function getStatusBadgeHtml(status) {
    var cls = 'status-' + status + '-student';
    var label = status.charAt(0).toUpperCase() + status.slice(1);
    return '<span class="status-badge ' + cls + '">' + label + '</span>';
  }

  function getRouteNameById(routeId) {
    if (!routeId) return '—';
    var route = routes.find(function (r) { return r.id === routeId; });
    return route ? route.route_name : '—';
  }

  function getStopNameById(routeId, stopId) {
    if (!stopId || !routeId) return '—';
    var stops = routeStopsCache[routeId];
    if (stops) {
      var stop = stops.find(function (s) { return s.id === stopId; });
      if (stop) return stop.stop_name;
    }
    return '—';
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    initPickupAutocomplete();
    loadRoutes().then(function () {
      return loadSchools();
    }).then(function () {
      loadStudents();
    });
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // Search and filters
    elements.searchInput.addEventListener('input', debounce(handleFilterChange, 300));
    elements.statusFilter.addEventListener('change', handleFilterChange);
    elements.routeFilter.addEventListener('change', handleFilterChange);

    // New student
    elements.btnNewStudent.addEventListener('click', openNewStudentForm);

    // Form modal
    elements.btnCloseModal.addEventListener('click', closeModal);
    elements.btnCancelForm.addEventListener('click', closeModal);
    elements.btnSaveStudent.addEventListener('click', handleFormSubmit);

    // Route change → load stops for selected route
    elements.formRoute.addEventListener('change', handleRouteChange);

    // Add guardian
    elements.btnAddGuardian.addEventListener('click', addGuardianRow);

    // Delete modal
    elements.btnCancelDelete.addEventListener('click', closeDeleteModal);
    elements.btnConfirmDelete.addEventListener('click', handleConfirmDelete);
  }

  // ---------------------------------------------------------------------------
  // Google Places Autocomplete for Pickup Address
  // ---------------------------------------------------------------------------

  function initPickupAutocomplete() {
    if (window.phoenixGooglePlaces) {
      var pickupInput = document.getElementById('form-pickup-address');
      if (pickupInput) {
        window.phoenixGooglePlaces.attachAutocomplete(pickupInput, function (place) {
          document.getElementById('form-pickup-lat').value = place.lat;
          document.getElementById('form-pickup-lng').value = place.lng;
          pickupInput.value = place.address;
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Load Schools (for dropdown)
  // ---------------------------------------------------------------------------

  async function loadSchools() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_schools?select=id,school_name&order=school_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        schools = await response.json();
      } else {
        schools = [];
      }
    } catch (e) {
      schools = [];
    }
    populateSchoolDropdown();
  }

  function populateSchoolDropdown() {
    var el = document.getElementById('form-school-id');
    if (!el) return;
    var html = '<option value="">— Select School —</option>';
    schools.forEach(function (school) {
      html += '<option value="' + school.id + '">' + escapeHtml(school.school_name) + '</option>';
    });
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // Load Routes (for dropdowns)
  // ---------------------------------------------------------------------------

  async function loadRoutes() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_routes?select=id,route_name,school_name,is_active&order=route_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        routes = await response.json();
      } else {
        routes = [];
      }
    } catch (e) {
      routes = [];
    }
    populateRouteFilterDropdown();
    populateFormRouteDropdown();
  }

  function populateRouteFilterDropdown() {
    var html = '<option value="">All Routes</option>';
    routes.forEach(function (route) {
      html += '<option value="' + route.id + '">' + escapeHtml(route.route_name) + '</option>';
    });
    elements.routeFilter.innerHTML = html;
  }

  function populateFormRouteDropdown() {
    var html = '<option value="">— None —</option>';
    routes.filter(function (r) { return r.is_active; }).forEach(function (route) {
      html += '<option value="' + route.id + '">' + escapeHtml(route.route_name) + '</option>';
    });
    elements.formRoute.innerHTML = html;
  }

  async function loadStopsForRoute(routeId) {
    if (!routeId) {
      elements.formStop.innerHTML = '<option value="">— Select Route First —</option>';
      elements.formStop.disabled = true;
      return [];
    }
    if (routeStopsCache[routeId]) {
      populateStopDropdown(routeStopsCache[routeId]);
      return routeStopsCache[routeId];
    }
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_stops?route_id=eq.' + routeId + '&order=stop_order.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        var stops = await response.json();
        routeStopsCache[routeId] = stops;
        populateStopDropdown(stops);
        return stops;
      }
    } catch (e) { /* ignore */ }
    elements.formStop.innerHTML = '<option value="">— No stops available —</option>';
    elements.formStop.disabled = true;
    return [];
  }

  function populateStopDropdown(stops) {
    if (!stops || stops.length === 0) {
      elements.formStop.innerHTML = '<option value="">— No stops on this route —</option>';
      elements.formStop.disabled = true;
      return;
    }
    var html = '<option value="">— Select Stop —</option>';
    stops.forEach(function (stop) {
      html += '<option value="' + stop.id + '">' + escapeHtml(stop.stop_name) + ' (#' + stop.stop_order + ')</option>';
    });
    elements.formStop.innerHTML = html;
    elements.formStop.disabled = false;
  }

  function handleRouteChange() {
    var routeId = elements.formRoute.value;
    hideCapacityInfo();
    loadStopsForRoute(routeId).then(function () {
      if (routeId) {
        checkRouteCapacity(routeId);
      }
    });
  }

  async function checkRouteCapacity(routeId) {
    try {
      // Get current student count for route
      var countUrl = SUPABASE_URL + '/rest/v1/transport_students?assigned_route_id=eq.' + routeId + '&status=eq.active&select=id';
      var countResp = await fetch(countUrl, {
        headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'count=exact' }),
      });
      var countData = await countResp.json();
      var currentCount = (countData || []).length;

      // If editing, subtract 1 since this student is already counted
      if (editingStudentId) {
        var existing = students.find(function (s) { return s.id === editingStudentId; });
        if (existing && existing.assigned_route_id === routeId) {
          currentCount = Math.max(0, currentCount - 1);
        }
      }

      // Get vehicle capacity for route via schedules
      var schedUrl = SUPABASE_URL + '/rest/v1/transport_schedules?route_id=eq.' + routeId + '&is_active=eq.true&select=vehicle_id,transport_vehicles(seating_capacity)';
      var schedResp = await fetch(schedUrl, { headers: getAuthHeaders() });
      var schedData = await schedResp.json();

      var capacity = null;
      if (schedData && schedData.length > 0) {
        // Use the minimum vehicle capacity across all active schedules
        schedData.forEach(function (sched) {
          if (sched.transport_vehicles && sched.transport_vehicles.seating_capacity) {
            var cap = sched.transport_vehicles.seating_capacity;
            if (capacity === null || cap < capacity) {
              capacity = cap;
            }
          }
        });
      }

      if (capacity !== null) {
        var remaining = capacity - currentCount;
        if (remaining <= 0) {
          showCapacityInfo('Vehicle capacity reached (' + currentCount + '/' + capacity + ' seats filled). Adding this student may be rejected.', true);
        } else if (remaining <= 3) {
          showCapacityInfo('Route nearing capacity: ' + currentCount + '/' + capacity + ' seats filled (' + remaining + ' remaining).', false);
        } else {
          hideCapacityInfo();
        }
      } else {
        hideCapacityInfo();
      }
    } catch (e) {
      hideCapacityInfo();
    }
  }

  function showCapacityInfo(msg, isError) {
    elements.capacityInfo.textContent = msg;
    elements.capacityInfo.classList.remove('hidden', 'capacity-error');
    if (isError) {
      elements.capacityInfo.classList.add('capacity-error');
    }
  }

  function hideCapacityInfo() {
    elements.capacityInfo.textContent = '';
    elements.capacityInfo.classList.add('hidden');
    elements.capacityInfo.classList.remove('capacity-error');
  }

  // ---------------------------------------------------------------------------
  // Load & Render Students
  // ---------------------------------------------------------------------------

  async function loadStudents() {
    var result = await callManageStudents({ action: 'list_students' });

    if (result.success && result.data) {
      students = Array.isArray(result.data) ? result.data : (result.data.students || []);
      applyFiltersAndRender();
    } else {
      // Fallback: direct Supabase query
      await loadStudentsDirectly();
    }
  }

  async function loadStudentsDirectly() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_students?select=*,transport_student_guardians(guardian_id,relationship,is_primary,transport_guardians(id,full_name,phone_number,whatsapp_number,email))&order=full_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        students = await response.json();
        applyFiltersAndRender();
      } else {
        elements.studentTableBody.innerHTML =
          '<tr class="empty-row"><td colspan="9">Failed to load students.</td></tr>';
      }
    } catch (err) {
      elements.studentTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="9">Error: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function handleFilterChange() {
    applyFiltersAndRender();
  }

  function applyFiltersAndRender() {
    var search = elements.searchInput.value.trim().toLowerCase();
    var statusVal = elements.statusFilter.value;
    var routeVal = elements.routeFilter.value;

    var filtered = students.filter(function (s) {
      // Status filter
      if (statusVal && s.status !== statusVal) return false;
      // Route filter
      if (routeVal && s.assigned_route_id !== routeVal) return false;
      // Search filter
      if (search) {
        var haystack = (s.full_name || '').toLowerCase() +
          ' ' + (s.grade || '').toLowerCase() +
          ' ' + (s.school_name || '').toLowerCase();
        // Also search guardian names
        if (s.transport_student_guardians) {
          s.transport_student_guardians.forEach(function (sg) {
            if (sg.transport_guardians) {
              haystack += ' ' + (sg.transport_guardians.full_name || '').toLowerCase();
            }
          });
        }
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });

    renderStudentTable(filtered);
    updateStats(students);
  }

  function updateStats(data) {
    var total = data.length;
    var active = data.filter(function (s) { return s.status === 'active'; }).length;
    var suspended = data.filter(function (s) { return s.status === 'suspended'; }).length;
    var removed = data.filter(function (s) { return s.status === 'removed'; }).length;

    elements.statTotal.textContent = total;
    elements.statActive.textContent = active;
    elements.statSuspended.textContent = suspended;
    elements.statRemoved.textContent = removed;
  }

  function renderStudentTable(data) {
    if (!data || data.length === 0) {
      elements.studentTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="9">No students found.</td></tr>';
      return;
    }

    elements.studentTableBody.innerHTML = data.map(function (student) {
      var guardianCount = student.transport_student_guardians
        ? student.transport_student_guardians.length : 0;
      var routeName = getRouteNameById(student.assigned_route_id);
      var stopName = getStopNameById(student.assigned_route_id, student.assigned_stop_id);
      var pickupAddr = student.pickup_address || '—';

      return (
        '<tr data-id="' + student.id + '">' +
        '<td class="student-name">' + escapeHtml(student.full_name) + '</td>' +
        '<td>' + escapeHtml(student.grade) + '</td>' +
        '<td>' + escapeHtml(student.school_name) + '</td>' +
        '<td>' + escapeHtml(pickupAddr) + '</td>' +
        '<td>' + escapeHtml(routeName) + '</td>' +
        '<td>' + escapeHtml(stopName) + '</td>' +
        '<td>' + guardianCount + '</td>' +
        '<td>' + getStatusBadgeHtml(student.status) + '</td>' +
        '<td class="action-links">' +
          '<button class="btn btn-sm btn-secondary btn-edit-student" data-id="' + student.id + '">Edit</button> ' +
          (student.status !== 'removed'
            ? '<button class="btn btn-sm btn-danger btn-delete-student" data-id="' + student.id + '">Remove</button>'
            : '') +
        '</td>' +
        '</tr>'
      );
    }).join('');

    // Bind action buttons
    elements.studentTableBody.querySelectorAll('.btn-edit-student').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEditStudentForm(this.getAttribute('data-id'));
      });
    });

    elements.studentTableBody.querySelectorAll('.btn-delete-student').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openDeleteConfirm(this.getAttribute('data-id'));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Guardian Row Management
  // ---------------------------------------------------------------------------

  function addGuardianRow(prefill) {
    guardianCounter++;
    var idx = guardianCounter;
    var data = prefill || {};

    var row = document.createElement('div');
    row.className = 'guardian-row';
    row.setAttribute('data-guardian-idx', idx);
    row.innerHTML =
      '<div class="guardian-row-header">' +
        '<span>Guardian #' + idx + '</span>' +
        '<button type="button" class="btn-remove-guardian" data-idx="' + idx + '">Remove</button>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label>Full Name *</label>' +
          '<input type="text" class="input-field guardian-name" data-idx="' + idx + '" value="' + escapeHtml(data.full_name || '') + '" placeholder="e.g. Mrs Mokoena" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Phone Number *</label>' +
          '<input type="text" class="input-field guardian-phone" data-idx="' + idx + '" value="' + escapeHtml(data.phone_number || '') + '" placeholder="e.g. +27821234567" />' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label>WhatsApp Number</label>' +
          '<input type="text" class="input-field guardian-whatsapp" data-idx="' + idx + '" value="' + escapeHtml(data.whatsapp_number || '') + '" placeholder="e.g. +27821234567" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Email</label>' +
          '<input type="email" class="input-field guardian-email" data-idx="' + idx + '" value="' + escapeHtml(data.email || '') + '" placeholder="e.g. parent@email.com" />' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label>Relationship</label>' +
          '<select class="input-field guardian-relationship" data-idx="' + idx + '">' +
            '<option value="parent"' + (data.relationship === 'parent' ? ' selected' : '') + '>Parent</option>' +
            '<option value="guardian"' + (data.relationship === 'guardian' ? ' selected' : '') + '>Guardian</option>' +
            '<option value="grandparent"' + (data.relationship === 'grandparent' ? ' selected' : '') + '>Grandparent</option>' +
            '<option value="sibling"' + (data.relationship === 'sibling' ? ' selected' : '') + '>Sibling</option>' +
            '<option value="other"' + (data.relationship === 'other' ? ' selected' : '') + '>Other</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="primary-check">' +
            '<input type="checkbox" class="guardian-primary" data-idx="' + idx + '"' + (data.is_primary ? ' checked' : '') + ' />' +
            ' Primary Guardian' +
          '</label>' +
        '</div>' +
      '</div>';

    elements.guardiansContainer.appendChild(row);

    // Bind remove button
    row.querySelector('.btn-remove-guardian').addEventListener('click', function () {
      removeGuardianRow(idx);
    });
  }

  function removeGuardianRow(idx) {
    var row = elements.guardiansContainer.querySelector('[data-guardian-idx="' + idx + '"]');
    if (row) {
      row.remove();
    }
  }

  function getGuardianData() {
    var guardians = [];
    var rows = elements.guardiansContainer.querySelectorAll('.guardian-row');
    rows.forEach(function (row) {
      var idx = row.getAttribute('data-guardian-idx');
      var name = row.querySelector('.guardian-name[data-idx="' + idx + '"]').value.trim();
      var phone = row.querySelector('.guardian-phone[data-idx="' + idx + '"]').value.trim();
      var whatsapp = row.querySelector('.guardian-whatsapp[data-idx="' + idx + '"]').value.trim();
      var email = row.querySelector('.guardian-email[data-idx="' + idx + '"]').value.trim();
      var relationship = row.querySelector('.guardian-relationship[data-idx="' + idx + '"]').value;
      var isPrimary = row.querySelector('.guardian-primary[data-idx="' + idx + '"]').checked;

      guardians.push({
        full_name: name,
        phone_number: phone,
        whatsapp_number: whatsapp || null,
        email: email || null,
        relationship: relationship,
        is_primary: isPrimary,
      });
    });
    return guardians;
  }

  function clearGuardians() {
    elements.guardiansContainer.innerHTML = '';
    guardianCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Student Form (Create / Edit)
  // ---------------------------------------------------------------------------

  function openNewStudentForm() {
    editingStudentId = null;
    elements.studentModalTitle.textContent = 'Register Student';
    elements.studentForm.reset();
    clearGuardians();
    addGuardianRow(); // At least one guardian row by default
    elements.formStop.innerHTML = '<option value="">— Select Route First —</option>';
    elements.formStop.disabled = true;
    hideFormError();
    hideCapacityInfo();
    populateFormRouteDropdown();
    populateSchoolDropdown();
    // Reset pickup address fields
    document.getElementById('form-pickup-address').value = '';
    document.getElementById('form-pickup-lat').value = '';
    document.getElementById('form-pickup-lng').value = '';
    var schoolIdEl = document.getElementById('form-school-id');
    if (schoolIdEl) schoolIdEl.value = '';
    openModal();
  }

  async function openEditStudentForm(studentId) {
    var student = students.find(function (s) { return s.id === studentId; });
    if (!student) return;

    editingStudentId = studentId;
    elements.studentModalTitle.textContent = 'Edit Student';
    hideFormError();
    hideCapacityInfo();

    // Populate student fields
    document.getElementById('form-full-name').value = student.full_name || '';
    document.getElementById('form-grade').value = student.grade || '';
    document.getElementById('form-school-name').value = student.school_name || '';
    document.getElementById('form-status').value = student.status || 'active';

    // Populate school dropdown
    populateSchoolDropdown();
    var schoolIdEl = document.getElementById('form-school-id');
    if (schoolIdEl) schoolIdEl.value = student.school_id || '';

    // Populate pickup address
    document.getElementById('form-pickup-address').value = student.pickup_address || '';
    document.getElementById('form-pickup-lat').value = student.pickup_lat || '';
    document.getElementById('form-pickup-lng').value = student.pickup_lng || '';

    // Populate route dropdown
    populateFormRouteDropdown();
    elements.formRoute.value = student.assigned_route_id || '';

    // Load stops and select the assigned stop
    if (student.assigned_route_id) {
      await loadStopsForRoute(student.assigned_route_id);
      elements.formStop.value = student.assigned_stop_id || '';
      checkRouteCapacity(student.assigned_route_id);
    } else {
      elements.formStop.innerHTML = '<option value="">— Select Route First —</option>';
      elements.formStop.disabled = true;
    }

    // Populate guardians
    clearGuardians();
    if (student.transport_student_guardians && student.transport_student_guardians.length > 0) {
      student.transport_student_guardians.forEach(function (sg) {
        var g = sg.transport_guardians || {};
        addGuardianRow({
          full_name: g.full_name || '',
          phone_number: g.phone_number || '',
          whatsapp_number: g.whatsapp_number || '',
          email: g.email || '',
          relationship: sg.relationship || 'parent',
          is_primary: sg.is_primary || false,
        });
      });
    } else {
      addGuardianRow(); // At least one row
    }

    openModal();
  }

  async function handleFormSubmit() {
    hideFormError();

    var fullName = document.getElementById('form-full-name').value.trim();
    var grade = document.getElementById('form-grade').value.trim();
    var schoolName = document.getElementById('form-school-name').value.trim();
    var status = document.getElementById('form-status').value;
    var routeId = elements.formRoute.value || null;
    var stopId = elements.formStop.value || null;
    var pickupAddress = document.getElementById('form-pickup-address').value.trim();
    var pickupLat = document.getElementById('form-pickup-lat').value;
    var pickupLng = document.getElementById('form-pickup-lng').value;
    var schoolId = document.getElementById('form-school-id').value || null;

    // Client-side validation
    if (!fullName) {
      showFormError('Full name is required.');
      return;
    }
    if (!grade) {
      showFormError('Grade is required.');
      return;
    }
    if (!schoolName) {
      showFormError('School name is required.');
      return;
    }

    // Validate guardians
    var guardians = getGuardianData();
    if (guardians.length === 0) {
      showFormError('At least one guardian is required.');
      return;
    }

    // Validate each guardian has required fields
    for (var i = 0; i < guardians.length; i++) {
      if (!guardians[i].full_name) {
        showFormError('Guardian #' + (i + 1) + ': Full name is required.');
        return;
      }
      if (!guardians[i].phone_number) {
        showFormError('Guardian #' + (i + 1) + ': Phone number is required.');
        return;
      }
    }

    // Validate stop-route consistency
    if (stopId && !routeId) {
      showFormError('A route must be selected when assigning a stop.');
      return;
    }

    var payload = {
      action: editingStudentId ? 'update_student' : 'create_student',
      student: {
        full_name: fullName,
        grade: grade,
        school_name: schoolName,
        status: status,
        assigned_route_id: routeId,
        assigned_stop_id: stopId,
        pickup_address: pickupAddress || null,
        pickup_lat: pickupLat ? parseFloat(pickupLat) : null,
        pickup_lng: pickupLng ? parseFloat(pickupLng) : null,
        school_id: schoolId,
      },
      guardians: guardians,
    };
    if (editingStudentId) {
      payload.student_id = editingStudentId;
    }

    var result = await callManageStudents(payload);

    if (result.success) {
      closeModal();
      loadStudents();
    } else {
      // Display server-side validation errors with context
      var errorMsg = result.error || 'Failed to save student.';
      if (errorMsg.toLowerCase().indexOf('capacity') !== -1) {
        showCapacityInfo(errorMsg, true);
      } else if (errorMsg.toLowerCase().indexOf('stop') !== -1 && errorMsg.toLowerCase().indexOf('route') !== -1) {
        showFormError('Stop-route mismatch: ' + errorMsg);
      } else {
        showFormError(errorMsg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Student (Soft-delete)
  // ---------------------------------------------------------------------------

  function openDeleteConfirm(studentId) {
    deletingStudentId = studentId;
    var student = students.find(function (s) { return s.id === studentId; });
    if (student) {
      elements.deleteMessage.textContent =
        'Are you sure you want to remove "' + student.full_name +
        '" (Grade ' + student.grade + ')? The student will be marked as removed.';
    }
    elements.deleteModal.classList.remove('hidden');
  }

  function closeDeleteModal() {
    deletingStudentId = null;
    elements.deleteModal.classList.add('hidden');
  }

  async function handleConfirmDelete() {
    if (!deletingStudentId) return;

    var result = await callManageStudents({
      action: 'delete_student',
      student_id: deletingStudentId,
    });

    closeDeleteModal();

    if (result.success) {
      loadStudents();
    } else {
      alert('Failed to remove student: ' + (result.error || 'Unknown error'));
    }
  }

  // ---------------------------------------------------------------------------
  // Modal Helpers
  // ---------------------------------------------------------------------------

  function openModal() {
    elements.studentModal.classList.remove('hidden');
  }

  function closeModal() {
    elements.studentModal.classList.add('hidden');
    editingStudentId = null;
    hideFormError();
    hideCapacityInfo();
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
