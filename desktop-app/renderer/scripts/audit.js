/**
 * Audit Log Page Controller
 *
 * Vanilla JS controller for the Transport Audit Log page.
 * Calls the `query_transport_audit_log` RPC function via Supabase for filtered data.
 *
 * Features:
 * - Filterable display: date range, user, event_type, entity_type
 * - Paginated results with page controls
 * - Expandable JSON details per row
 * - Auto-refresh toggle (polls every 30 seconds)
 *
 * Requirements: 14.4
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var PAGE_SIZE = 25;
  var AUTO_REFRESH_INTERVAL_MS = 30000;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    records: [],
    totalCount: 0,
    currentPage: 1,
    totalPages: 1,
    autoRefreshEnabled: false,
    autoRefreshTimer: null,
    isLoading: false,
    filters: {
      dateFrom: '',
      dateTo: '',
      userId: '',
      eventType: '',
      entityType: '',
    },
  };

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  var SUPABASE_URL = window.phoenixConfig
    ? window.phoenixConfig.supabaseUrl
    : 'https://gktfyhyfbenqnouhsmqe.supabase.co';
  var SUPABASE_KEY = window.phoenixConfig
    ? window.phoenixConfig.supabaseAnonKey
    : '';

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // Filters
    filterDateFrom: document.getElementById('filter-date-from'),
    filterDateTo: document.getElementById('filter-date-to'),
    filterUser: document.getElementById('filter-user'),
    filterEventType: document.getElementById('filter-event-type'),
    filterEntityType: document.getElementById('filter-entity-type'),
    btnApplyFilters: document.getElementById('btn-apply-filters'),
    btnClearFilters: document.getElementById('btn-clear-filters'),
    toggleAutoRefresh: document.getElementById('toggle-auto-refresh'),

    // Display
    auditError: document.getElementById('audit-error'),
    auditLoading: document.getElementById('audit-loading'),
    auditResults: document.getElementById('audit-results'),
    auditTableBody: document.getElementById('audit-table-body'),
    resultsCount: document.getElementById('results-count'),
    refreshIndicator: document.getElementById('refresh-indicator'),

    // Pagination
    pageCurrent: document.getElementById('page-current'),
    pageTotal: document.getElementById('page-total'),
    btnPageFirst: document.getElementById('btn-page-first'),
    btnPagePrev: document.getElementById('btn-page-prev'),
    btnPageNext: document.getElementById('btn-page-next'),
    btnPageLast: document.getElementById('btn-page-last'),

    // Logout
    logoutBtn: document.getElementById('logout-btn'),
  };

  // ---------------------------------------------------------------------------
  // Auth Helpers
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // API Calls
  // ---------------------------------------------------------------------------

  /**
   * Query the audit log via the `query_transport_audit_log` RPC function.
   * @param {object} params - Filter and pagination parameters
   * @returns {Promise<{success: boolean, data?: object[], count?: number, error?: string}>}
   */
  async function queryAuditLog(params) {
    try {
      var payload = {
        p_limit: PAGE_SIZE,
        p_offset: (state.currentPage - 1) * PAGE_SIZE,
      };

      if (params.dateFrom) {
        payload.p_date_from = params.dateFrom + 'T00:00:00Z';
      }
      if (params.dateTo) {
        payload.p_date_to = params.dateTo + 'T23:59:59Z';
      }
      if (params.userId) {
        payload.p_user_id = params.userId;
      }
      if (params.eventType) {
        payload.p_event_type = params.eventType;
      }
      if (params.entityType) {
        payload.p_entity_type = params.entityType;
      }

      var response = await fetch(SUPABASE_URL + '/rest/v1/rpc/query_transport_audit_log', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        var errorData = await response.json().catch(function () { return {}; });
        return {
          success: false,
          error: errorData.message || errorData.error || 'Failed to fetch audit log (' + response.status + ')',
        };
      }

      var data = await response.json();

      // The RPC returns an array of records; total_count is expected in each row or as a separate field
      var totalCount = 0;
      var records = [];

      if (Array.isArray(data)) {
        records = data;
        // If the RPC returns total_count in each row, extract it
        if (records.length > 0 && records[0].total_count !== undefined) {
          totalCount = parseInt(records[0].total_count, 10) || 0;
        } else {
          // Fallback: if no total_count, use returned length (may be capped at PAGE_SIZE)
          totalCount = records.length >= PAGE_SIZE
            ? (state.currentPage * PAGE_SIZE) + 1
            : ((state.currentPage - 1) * PAGE_SIZE) + records.length;
        }
      }

      return { success: true, data: records, count: totalCount };
    } catch (err) {
      console.error('[audit.js] Network error querying audit log:', err);
      return { success: false, error: err.message || 'Network error' };
    }
  }

  /**
   * Fetch distinct users who have audit entries (for the user filter dropdown).
   */
  async function fetchAuditUsers() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_audit_log?select=user_id&order=user_id.asc';
      var response = await fetch(url, {
        headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
      });
      if (!response.ok) return [];

      var data = await response.json();
      // Get unique user_ids
      var userIds = [];
      var seen = {};
      data.forEach(function (row) {
        if (row.user_id && !seen[row.user_id]) {
          seen[row.user_id] = true;
          userIds.push(row.user_id);
        }
      });
      return userIds;
    } catch (err) {
      console.error('[audit.js] Failed to fetch audit users:', err);
      return [];
    }
  }

  /**
   * Fetch distinct event_types for the event type filter dropdown.
   */
  async function fetchEventTypes() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_audit_log?select=event_type&order=event_type.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (!response.ok) return [];

      var data = await response.json();
      var types = [];
      var seen = {};
      data.forEach(function (row) {
        if (row.event_type && !seen[row.event_type]) {
          seen[row.event_type] = true;
          types.push(row.event_type);
        }
      });
      return types;
    } catch (err) {
      console.error('[audit.js] Failed to fetch event types:', err);
      return [];
    }
  }

  /**
   * Fetch distinct entity_types for the entity type filter dropdown.
   */
  async function fetchEntityTypes() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_audit_log?select=entity_type&order=entity_type.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (!response.ok) return [];

      var data = await response.json();
      var types = [];
      var seen = {};
      data.forEach(function (row) {
        if (row.entity_type && !seen[row.entity_type]) {
          seen[row.entity_type] = true;
          types.push(row.entity_type);
        }
      });
      return types;
    } catch (err) {
      console.error('[audit.js] Failed to fetch entity types:', err);
      return [];
    }
  }

  /**
   * Fetch user details (email/name) for display.
   * @param {string[]} userIds
   * @returns {Promise<Object>} Map of user_id -> { email, display_name }
   */
  async function fetchUserDetails(userIds) {
    if (!userIds || userIds.length === 0) return {};
    try {
      var idsParam = userIds.map(function (id) { return 'id.eq.' + id; }).join(',');
      var url = SUPABASE_URL + '/rest/v1/users?select=id,email,display_name&or=(' + idsParam + ')';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (!response.ok) return {};

      var data = await response.json();
      var map = {};
      data.forEach(function (user) {
        map[user.id] = {
          email: user.email || '',
          display_name: user.display_name || user.email || 'Unknown',
        };
      });
      return map;
    } catch (err) {
      console.error('[audit.js] Failed to fetch user details:', err);
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    setDefaultDates();
    bindEvents();
    loadFilterOptions();
    loadAuditLog();
  }

  function setDefaultDates() {
    var now = new Date();
    var sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    elements.filterDateFrom.value = formatDateInput(sevenDaysAgo);
    elements.filterDateTo.value = formatDateInput(now);

    state.filters.dateFrom = elements.filterDateFrom.value;
    state.filters.dateTo = elements.filterDateTo.value;
  }

  function formatDateInput(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  async function loadFilterOptions() {
    // Load event types
    var eventTypes = await fetchEventTypes();
    elements.filterEventType.innerHTML = '<option value="">All Events</option>';
    eventTypes.forEach(function (type) {
      var option = document.createElement('option');
      option.value = type;
      option.textContent = formatEventType(type);
      elements.filterEventType.appendChild(option);
    });

    // Load entity types
    var entityTypes = await fetchEntityTypes();
    elements.filterEntityType.innerHTML = '<option value="">All Entities</option>';
    entityTypes.forEach(function (type) {
      var option = document.createElement('option');
      option.value = type;
      option.textContent = formatEntityType(type);
      elements.filterEntityType.appendChild(option);
    });

    // Load users
    var userIds = await fetchAuditUsers();
    var userMap = await fetchUserDetails(userIds);
    elements.filterUser.innerHTML = '<option value="">All Users</option>';
    userIds.forEach(function (uid) {
      var option = document.createElement('option');
      option.value = uid;
      var info = userMap[uid];
      option.textContent = info ? (info.display_name || info.email) : uid.substring(0, 8) + '...';
      elements.filterUser.appendChild(option);
    });
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    elements.btnApplyFilters.addEventListener('click', handleApplyFilters);
    elements.btnClearFilters.addEventListener('click', handleClearFilters);
    elements.toggleAutoRefresh.addEventListener('change', handleToggleAutoRefresh);

    elements.btnPageFirst.addEventListener('click', function () { goToPage(1); });
    elements.btnPagePrev.addEventListener('click', function () { goToPage(state.currentPage - 1); });
    elements.btnPageNext.addEventListener('click', function () { goToPage(state.currentPage + 1); });
    elements.btnPageLast.addEventListener('click', function () { goToPage(state.totalPages); });

    if (elements.logoutBtn) {
      elements.logoutBtn.addEventListener('click', handleLogout);
    }

    // Allow Enter key on filter inputs to trigger apply
    var filterInputs = [
      elements.filterDateFrom,
      elements.filterDateTo,
      elements.filterUser,
      elements.filterEventType,
      elements.filterEntityType,
    ];
    filterInputs.forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          handleApplyFilters();
        }
      });
    });
  }

  function handleLogout() {
    stopAutoRefresh();
    localStorage.removeItem('phoenix-desktop-auth');
    window.location.href = 'login.html';
  }

  // ---------------------------------------------------------------------------
  // Filter Handlers
  // ---------------------------------------------------------------------------

  function handleApplyFilters() {
    state.filters.dateFrom = elements.filterDateFrom.value;
    state.filters.dateTo = elements.filterDateTo.value;
    state.filters.userId = elements.filterUser.value;
    state.filters.eventType = elements.filterEventType.value;
    state.filters.entityType = elements.filterEntityType.value;
    state.currentPage = 1;
    loadAuditLog();
  }

  function handleClearFilters() {
    elements.filterDateFrom.value = '';
    elements.filterDateTo.value = '';
    elements.filterUser.value = '';
    elements.filterEventType.value = '';
    elements.filterEntityType.value = '';

    state.filters = {
      dateFrom: '',
      dateTo: '',
      userId: '',
      eventType: '',
      entityType: '',
    };
    state.currentPage = 1;
    loadAuditLog();
  }

  // ---------------------------------------------------------------------------
  // Auto-Refresh
  // ---------------------------------------------------------------------------

  function handleToggleAutoRefresh() {
    state.autoRefreshEnabled = elements.toggleAutoRefresh.checked;
    if (state.autoRefreshEnabled) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    elements.refreshIndicator.classList.add('visible');
    state.autoRefreshTimer = setInterval(function () {
      if (!state.isLoading) {
        loadAuditLog(true);
      }
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    elements.refreshIndicator.classList.remove('visible');
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Load Audit Log
  // ---------------------------------------------------------------------------

  /**
   * @param {boolean} [silent] - If true, don't show loading indicator (used for auto-refresh)
   */
  async function loadAuditLog(silent) {
    if (state.isLoading) return;
    state.isLoading = true;

    if (!silent) {
      showLoading();
      hideError();
      elements.auditResults.classList.add('hidden');
    }

    var result = await queryAuditLog(state.filters);

    state.isLoading = false;

    if (!result.success) {
      if (!silent) {
        hideLoading();
        showError(result.error || 'Failed to load audit log.');
      }
      return;
    }

    state.records = result.data || [];
    state.totalCount = result.count || 0;
    state.totalPages = Math.max(1, Math.ceil(state.totalCount / PAGE_SIZE));

    if (!silent) {
      hideLoading();
    }

    renderAuditTable();
    updatePagination();
    elements.auditResults.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // Render Audit Table
  // ---------------------------------------------------------------------------

  function renderAuditTable() {
    var records = state.records;

    elements.resultsCount.textContent = state.totalCount + ' record' + (state.totalCount !== 1 ? 's' : '');

    if (records.length === 0) {
      elements.auditTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="6">No audit records found for the selected filters.</td></tr>';
      return;
    }

    var html = '';
    records.forEach(function (record, index) {
      var timestamp = formatTimestamp(record.created_at);
      var userName = record.user_email || record.user_display_name || (record.user_id ? record.user_id.substring(0, 8) + '...' : 'System');
      var eventType = record.event_type || '—';
      var entityType = record.entity_type || '—';
      var entityId = record.entity_id ? record.entity_id.substring(0, 8) + '...' : '—';
      var details = record.details;

      html += '<tr>';
      html += '<td>' + escapeHtml(timestamp) + '</td>';
      html += '<td>' + escapeHtml(userName) + '</td>';
      html += '<td>' + renderEventBadge(eventType) + '</td>';
      html += '<td>' + escapeHtml(formatEntityType(entityType)) + '</td>';
      html += '<td title="' + escapeHtml(record.entity_id || '') + '">' + escapeHtml(entityId) + '</td>';
      html += '<td class="details-cell">' + renderDetails(details, index) + '</td>';
      html += '</tr>';
    });

    elements.auditTableBody.innerHTML = html;

    // Bind details toggle events
    var toggleButtons = elements.auditTableBody.querySelectorAll('.details-toggle');
    toggleButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-target');
        var content = document.getElementById(targetId);
        if (content) {
          content.classList.toggle('expanded');
          btn.textContent = content.classList.contains('expanded') ? 'Hide' : 'Show';
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  function updatePagination() {
    elements.pageCurrent.textContent = state.currentPage;
    elements.pageTotal.textContent = state.totalPages;

    elements.btnPageFirst.disabled = state.currentPage <= 1;
    elements.btnPagePrev.disabled = state.currentPage <= 1;
    elements.btnPageNext.disabled = state.currentPage >= state.totalPages;
    elements.btnPageLast.disabled = state.currentPage >= state.totalPages;
  }

  function goToPage(page) {
    if (page < 1 || page > state.totalPages) return;
    state.currentPage = page;
    loadAuditLog();
  }

  // ---------------------------------------------------------------------------
  // Rendering Helpers
  // ---------------------------------------------------------------------------

  function renderEventBadge(eventType) {
    var badgeClass = 'event-badge--default';
    var lower = eventType.toLowerCase();

    if (lower.indexOf('create') !== -1 || lower.indexOf('insert') !== -1 || lower.indexOf('register') !== -1) {
      badgeClass = 'event-badge--create';
    } else if (lower.indexOf('update') !== -1 || lower.indexOf('modify') !== -1 || lower.indexOf('edit') !== -1) {
      badgeClass = 'event-badge--update';
    } else if (lower.indexOf('delete') !== -1 || lower.indexOf('remove') !== -1) {
      badgeClass = 'event-badge--delete';
    } else if (lower.indexOf('login') !== -1 || lower.indexOf('auth') !== -1 || lower.indexOf('logout') !== -1) {
      badgeClass = 'event-badge--login';
    }

    return '<span class="event-badge ' + badgeClass + '">' + escapeHtml(formatEventType(eventType)) + '</span>';
  }

  function renderDetails(details, index) {
    if (!details || (typeof details === 'object' && Object.keys(details).length === 0)) {
      return '<span style="color:var(--color-text-muted);font-size:11px;">—</span>';
    }

    var detailsId = 'details-content-' + index;
    var jsonStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);

    return '<button class="details-toggle" data-target="' + detailsId + '">Show</button>' +
      '<div id="' + detailsId + '" class="details-content">' + escapeHtml(jsonStr) + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Formatting Helpers
  // ---------------------------------------------------------------------------

  function formatTimestamp(isoStr) {
    if (!isoStr) return '—';
    try {
      var date = new Date(isoStr);
      return date.toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }) + ' ' + date.toLocaleTimeString('en-ZA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (e) {
      return isoStr;
    }
  }

  function formatEventType(type) {
    if (!type) return '—';
    // Convert snake_case to Title Case
    return type.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function formatEntityType(type) {
    if (!type) return '—';
    // Remove 'transport_' prefix if present and format
    var cleaned = type.replace(/^transport_/, '');
    return cleaned.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------

  function showLoading() {
    elements.auditLoading.classList.remove('hidden');
  }

  function hideLoading() {
    elements.auditLoading.classList.add('hidden');
  }

  function showError(message) {
    elements.auditError.textContent = message;
    elements.auditError.classList.remove('hidden');
  }

  function hideError() {
    elements.auditError.textContent = '';
    elements.auditError.classList.add('hidden');
  }

  function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    function bootstrap() {
      init();
    }

    if (window.__phoenixServicesReady) {
      bootstrap();
    } else {
      window.addEventListener('phoenixServicesReady', bootstrap);
      // Fallback: if services never fire (direct page load), init after short delay
      setTimeout(function () {
        if (!window.__phoenixServicesReady) {
          bootstrap();
        }
      }, 1000);
    }
  });
})();
