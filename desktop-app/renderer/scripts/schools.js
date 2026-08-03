/**
 * Schools Page Controller
 *
 * Manages CRUD for transport_schools table, displays students grouped by school,
 * and shows guardian/pickup details in expandable rows.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var schools = [];
  var studentsMap = {}; // { schoolId: [students] }
  var allStudents = [];
  var editingSchoolId = null;
  var deletingSchoolId = null;

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    schoolTableBody: document.getElementById('school-table-body'),
    searchInput: document.getElementById('search-input'),
    btnNewSchool: document.getElementById('btn-new-school'),

    // Stats
    statTotalSchools: document.getElementById('stat-total-schools'),
    statTotalStudents: document.getElementById('stat-total-students'),
    statUnassigned: document.getElementById('stat-unassigned'),

    // Form modal
    schoolModal: document.getElementById('school-modal'),
    schoolModalTitle: document.getElementById('school-modal-title'),
    schoolForm: document.getElementById('school-form'),
    formError: document.getElementById('form-error'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCancelForm: document.getElementById('btn-cancel-form'),
    btnSaveSchool: document.getElementById('btn-save-school'),

    // Delete modal
    deleteModal: document.getElementById('delete-modal'),
    deleteMessage: document.getElementById('delete-message'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete'),
  };

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  var SUPABASE_URL = window.phoenixConfig
    ? window.phoenixConfig.supabaseUrl
    : 'https://ptskyueshtjjesxeusot.supabase.co';
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

  function getTenantId() {
    try {
      var sessionStr = localStorage.getItem('phoenix-desktop-auth');
      if (sessionStr) {
        var session = JSON.parse(sessionStr);
        return session.user?.tenant_id || session.tenant_id || null;
      }
    } catch (e) { /* ignore */ }
    return null;
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

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    initGooglePlaces();
    loadData();
  }

  function bindEvents() {
    elements.searchInput.addEventListener('input', debounce(handleFilterChange, 300));
    elements.btnNewSchool.addEventListener('click', openNewSchoolForm);
    elements.btnCloseModal.addEventListener('click', closeModal);
    elements.btnCancelForm.addEventListener('click', closeModal);
    elements.btnSaveSchool.addEventListener('click', handleFormSubmit);
    elements.btnCancelDelete.addEventListener('click', closeDeleteModal);
    elements.btnConfirmDelete.addEventListener('click', handleConfirmDelete);
  }

  function initGooglePlaces() {
    if (window.phoenixGooglePlaces) {
      var addressInput = document.getElementById('form-school-address');
      if (addressInput) {
        window.phoenixGooglePlaces.attachAutocomplete(addressInput, function (place) {
          document.getElementById('form-school-lat').value = place.lat;
          document.getElementById('form-school-lng').value = place.lng;
          addressInput.value = place.address;
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data Loading
  // ---------------------------------------------------------------------------

  async function loadData() {
    await Promise.all([loadSchools(), loadAllStudents()]);
    buildStudentsMap();
    applyFiltersAndRender();
    updateStats();
  }

  async function loadSchools() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_schools?select=*&order=school_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        schools = await response.json();
      } else {
        schools = [];
        console.error('[schools] Failed to load schools:', response.status);
      }
    } catch (err) {
      schools = [];
      console.error('[schools] Error loading schools:', err.message);
    }
  }

  async function loadAllStudents() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_students?select=*,transport_student_guardians(guardian_id,relationship,is_primary,transport_guardians(id,full_name,phone_number)),transport_routes(route_name)&status=neq.removed&order=full_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        allStudents = await response.json();
      } else {
        allStudents = [];
        console.error('[schools] Failed to load students:', response.status);
      }
    } catch (err) {
      allStudents = [];
      console.error('[schools] Error loading students:', err.message);
    }
  }

  function buildStudentsMap() {
    studentsMap = {};
    allStudents.forEach(function (student) {
      var key = student.school_id || null;
      // Also match by school_name if school_id is not set
      if (!key) {
        var matchedSchool = schools.find(function (s) {
          return s.school_name && student.school_name &&
            s.school_name.toLowerCase() === student.school_name.toLowerCase();
        });
        if (matchedSchool) {
          key = matchedSchool.id;
        }
      }
      if (key) {
        if (!studentsMap[key]) studentsMap[key] = [];
        studentsMap[key].push(student);
      }
    });
  }

  function getStudentCountForSchool(schoolId) {
    return (studentsMap[schoolId] || []).length;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  function updateStats() {
    elements.statTotalSchools.textContent = schools.length;
    elements.statTotalStudents.textContent = allStudents.length;

    // Unassigned = students whose school_id is null AND school_name doesn't match any school
    var unassigned = allStudents.filter(function (s) {
      if (s.school_id) return false;
      var matched = schools.find(function (sch) {
        return sch.school_name && s.school_name &&
          sch.school_name.toLowerCase() === s.school_name.toLowerCase();
      });
      return !matched;
    });
    elements.statUnassigned.textContent = unassigned.length;
  }

  // ---------------------------------------------------------------------------
  // Filtering & Rendering
  // ---------------------------------------------------------------------------

  function handleFilterChange() {
    applyFiltersAndRender();
  }

  function applyFiltersAndRender() {
    var search = elements.searchInput.value.trim().toLowerCase();

    var filtered = schools.filter(function (school) {
      if (search) {
        var haystack = (school.school_name || '').toLowerCase() +
          ' ' + (school.address || '').toLowerCase() +
          ' ' + (school.principal_name || '').toLowerCase();
        return haystack.indexOf(search) !== -1;
      }
      return true;
    });

    renderSchoolTable(filtered);
  }

  function renderSchoolTable(data) {
    if (!data || data.length === 0) {
      elements.schoolTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="7">No schools found.</td></tr>';
      return;
    }

    var html = '';
    data.forEach(function (school) {
      var studentCount = getStudentCountForSchool(school.id);
      html +=
        '<tr class="school-row" data-id="' + school.id + '">' +
        '<td><span class="expand-icon">▶</span></td>' +
        '<td><strong>' + escapeHtml(school.school_name) + '</strong></td>' +
        '<td>' + escapeHtml(school.address || '—') + '</td>' +
        '<td>' + studentCount + '</td>' +
        '<td>' + escapeHtml(school.contact_phone || '—') + '</td>' +
        '<td>' + escapeHtml(school.principal_name || '—') + '</td>' +
        '<td class="action-links">' +
          '<button class="btn btn-sm btn-secondary btn-edit-school" data-id="' + school.id + '">Edit</button> ' +
          '<button class="btn btn-sm btn-danger btn-delete-school" data-id="' + school.id + '">Delete</button>' +
        '</td>' +
        '</tr>' +
        '<tr class="school-detail-row" data-school-detail="' + school.id + '">' +
        '<td colspan="7">' +
          '<div class="school-detail-content">' +
            buildStudentSubtable(school.id) +
          '</div>' +
        '</td>' +
        '</tr>';
    });

    elements.schoolTableBody.innerHTML = html;
    bindTableEvents();
  }

  function buildStudentSubtable(schoolId) {
    var students = studentsMap[schoolId] || [];
    if (students.length === 0) {
      return '<div class="no-students-msg">No students assigned to this school.</div>';
    }

    var html = '<h4>Students (' + students.length + ')</h4>';
    html += '<table class="students-subtable"><thead><tr>';
    html += '<th>Student Name</th><th>Grade</th><th>Guardian(s)</th><th>Pickup Address</th><th>Route</th>';
    html += '</tr></thead><tbody>';

    students.forEach(function (student) {
      var guardianNames = '';
      if (student.transport_student_guardians && student.transport_student_guardians.length > 0) {
        guardianNames = student.transport_student_guardians.map(function (sg) {
          var g = sg.transport_guardians;
          if (!g) return '—';
          var name = g.full_name || '—';
          if (sg.is_primary) name += ' ★';
          return name;
        }).join(', ');
      } else {
        guardianNames = '—';
      }

      var routeName = '—';
      if (student.transport_routes) {
        routeName = student.transport_routes.route_name || '—';
      }

      html += '<tr>';
      html += '<td>' + escapeHtml(student.full_name) + '</td>';
      html += '<td>' + escapeHtml(student.grade) + '</td>';
      html += '<td>' + escapeHtml(guardianNames) + '</td>';
      html += '<td>' + escapeHtml(student.pickup_address || '—') + '</td>';
      html += '<td>' + escapeHtml(routeName) + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
  }

  function bindTableEvents() {
    // Expand/collapse rows
    elements.schoolTableBody.querySelectorAll('.school-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Don't toggle if clicking action buttons
        if (e.target.closest('.action-links')) return;
        toggleSchoolDetail(row.getAttribute('data-id'));
      });
    });

    // Edit buttons
    elements.schoolTableBody.querySelectorAll('.btn-edit-school').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openEditSchoolForm(this.getAttribute('data-id'));
      });
    });

    // Delete buttons
    elements.schoolTableBody.querySelectorAll('.btn-delete-school').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openDeleteConfirm(this.getAttribute('data-id'));
      });
    });
  }

  function toggleSchoolDetail(schoolId) {
    var row = elements.schoolTableBody.querySelector('.school-row[data-id="' + schoolId + '"]');
    var detailRow = elements.schoolTableBody.querySelector('[data-school-detail="' + schoolId + '"]');

    if (!row || !detailRow) return;

    if (row.classList.contains('expanded')) {
      row.classList.remove('expanded');
      detailRow.classList.remove('visible');
    } else {
      row.classList.add('expanded');
      detailRow.classList.add('visible');
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD - Create / Edit School
  // ---------------------------------------------------------------------------

  function openNewSchoolForm() {
    editingSchoolId = null;
    elements.schoolModalTitle.textContent = 'Add School';
    elements.schoolForm.reset();
    document.getElementById('form-school-lat').value = '';
    document.getElementById('form-school-lng').value = '';
    hideFormError();
    openModal();
  }

  function openEditSchoolForm(schoolId) {
    var school = schools.find(function (s) { return s.id === schoolId; });
    if (!school) return;

    editingSchoolId = schoolId;
    elements.schoolModalTitle.textContent = 'Edit School';
    hideFormError();

    document.getElementById('form-school-name').value = school.school_name || '';
    document.getElementById('form-school-address').value = school.address || '';
    document.getElementById('form-school-lat').value = school.latitude || '';
    document.getElementById('form-school-lng').value = school.longitude || '';
    document.getElementById('form-contact-phone').value = school.contact_phone || '';
    document.getElementById('form-contact-email').value = school.contact_email || '';
    document.getElementById('form-principal-name').value = school.principal_name || '';

    openModal();
  }

  async function handleFormSubmit() {
    hideFormError();

    var schoolName = document.getElementById('form-school-name').value.trim();
    var address = document.getElementById('form-school-address').value.trim();
    var lat = document.getElementById('form-school-lat').value;
    var lng = document.getElementById('form-school-lng').value;
    var contactPhone = document.getElementById('form-contact-phone').value.trim();
    var contactEmail = document.getElementById('form-contact-email').value.trim();
    var principalName = document.getElementById('form-principal-name').value.trim();

    // Validation
    if (!schoolName) {
      showFormError('School name is required.');
      return;
    }

    var tenantId = getTenantId();
    if (!tenantId) {
      showFormError('Session error: no tenant ID found. Please log in again.');
      return;
    }

    var payload = {
      school_name: schoolName,
      address: address || null,
      latitude: lat ? parseFloat(lat) : null,
      longitude: lng ? parseFloat(lng) : null,
      contact_phone: contactPhone || null,
      contact_email: contactEmail || null,
      principal_name: principalName || null,
      tenant_id: tenantId,
      updated_at: new Date().toISOString(),
    };

    try {
      var url, method;
      if (editingSchoolId) {
        url = SUPABASE_URL + '/rest/v1/transport_schools?id=eq.' + editingSchoolId;
        method = 'PATCH';
      } else {
        url = SUPABASE_URL + '/rest/v1/transport_schools';
        method = 'POST';
      }

      var headers = Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' });
      var response = await fetch(url, {
        method: method,
        headers: headers,
        body: JSON.stringify(payload),
      });

      if (response.ok || response.status === 201) {
        closeModal();
        await loadData();
      } else {
        var errData = await response.json().catch(function () { return {}; });
        var errMsg = errData.message || errData.error || 'Failed to save school.';
        if (errMsg.indexOf('duplicate') !== -1 || errMsg.indexOf('unique') !== -1) {
          showFormError('A school with this name already exists for your organization.');
        } else {
          showFormError(errMsg);
        }
      }
    } catch (err) {
      showFormError('Network error: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD - Delete School
  // ---------------------------------------------------------------------------

  function openDeleteConfirm(schoolId) {
    deletingSchoolId = schoolId;
    var school = schools.find(function (s) { return s.id === schoolId; });
    if (school) {
      var count = getStudentCountForSchool(schoolId);
      var msg = 'Are you sure you want to delete "' + school.school_name + '"?';
      if (count > 0) {
        msg += ' This school has ' + count + ' student(s) assigned. They will lose their school assignment.';
      }
      elements.deleteMessage.textContent = msg;
    }
    elements.deleteModal.classList.remove('hidden');
  }

  function closeDeleteModal() {
    deletingSchoolId = null;
    elements.deleteModal.classList.add('hidden');
  }

  async function handleConfirmDelete() {
    if (!deletingSchoolId) return;

    try {
      // First, unset school_id on students assigned to this school
      var studentsForSchool = studentsMap[deletingSchoolId] || [];
      if (studentsForSchool.length > 0) {
        var updateUrl = SUPABASE_URL + '/rest/v1/transport_students?school_id=eq.' + deletingSchoolId;
        await fetch(updateUrl, {
          method: 'PATCH',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ school_id: null }),
        });
      }

      // Now delete the school
      var url = SUPABASE_URL + '/rest/v1/transport_schools?id=eq.' + deletingSchoolId;
      var response = await fetch(url, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      closeDeleteModal();

      if (response.ok || response.status === 204) {
        await loadData();
      } else {
        var errData = await response.json().catch(function () { return {}; });
        alert('Failed to delete school: ' + (errData.message || 'Unknown error'));
      }
    } catch (err) {
      closeDeleteModal();
      alert('Network error: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Modal Helpers
  // ---------------------------------------------------------------------------

  function openModal() {
    elements.schoolModal.classList.remove('hidden');
  }

  function closeModal() {
    elements.schoolModal.classList.add('hidden');
    editingSchoolId = null;
    hideFormError();
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
  // Initialize
  // ---------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
