/**
 * Reports Page Controller
 *
 * Vanilla JS controller for the Transport Reports & Analytics page.
 * Calls the generate-transport-report Edge Function for:
 *   - Daily Trip Summary
 *   - Monthly Attendance
 *   - Monthly Revenue
 *
 * Provides CSV and PDF export, and a dashboard with key metrics.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var currentReportData = null;
  var currentReportType = '';
  var availableRoutes = [];

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
    // Dashboard metrics
    metricActiveStudents: document.getElementById('metric-active-students'),
    metricActiveRoutes: document.getElementById('metric-active-routes'),
    metricFleetUtilisation: document.getElementById('metric-fleet-utilisation'),
    metricMonthlyRevenue: document.getElementById('metric-monthly-revenue'),

    // Controls
    reportType: document.getElementById('report-type'),
    dateFrom: document.getElementById('report-date-from'),
    dateTo: document.getElementById('report-date-to'),
    routeFilter: document.getElementById('report-route-filter'),
    btnGenerate: document.getElementById('btn-generate-report'),

    // Loading / Error
    reportLoading: document.getElementById('report-loading'),
    reportError: document.getElementById('report-error'),

    // Report display
    reportDisplay: document.getElementById('report-display'),
    reportTitle: document.getElementById('report-title'),
    reportGeneratedDate: document.getElementById('report-generated-date'),
    reportSummaryPanel: document.getElementById('report-summary-panel'),
    reportSummaryStats: document.getElementById('report-summary-stats'),
    reportTablesContainer: document.getElementById('report-tables-container'),

    // Export
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnExportPdf: document.getElementById('btn-export-pdf'),

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
  // Edge Function Calls
  // ---------------------------------------------------------------------------

  /**
   * Call the generate-transport-report Edge Function.
   * @param {object} payload - { report_type, start_date, end_date, route_id? }
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async function callGenerateReport(payload) {
    try {
      var response = await fetch(SUPABASE_URL + '/functions/v1/generate-transport-report', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      var data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || 'Report generation failed (' + response.status + ')' };
      }
      return { success: true, data: data };
    } catch (err) {
      console.error('[reports.js] Network error calling generate-transport-report:', err);
      return { success: false, error: err.message || 'Network error' };
    }
  }

  /**
   * Fetch all active routes for the route filter dropdown.
   */
  async function fetchRoutes() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_routes?select=id,route_name&is_active=eq.true&order=route_name.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        return await response.json();
      }
      return [];
    } catch (err) {
      console.error('[reports.js] Failed to fetch routes:', err);
      return [];
    }
  }

  /**
   * Fetch dashboard metrics from direct queries.
   */
  async function fetchDashboardMetrics() {
    var metrics = {
      activeStudents: 0,
      activeRoutes: 0,
      fleetUtilisation: 0,
      monthlyRevenue: 0,
    };

    try {
      // Active students count
      var studentsUrl = SUPABASE_URL + '/rest/v1/transport_students?select=id&status=eq.active';
      var studentsRes = await fetch(studentsUrl, {
        headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'count=exact' }),
      });
      if (studentsRes.ok) {
        var contentRange = studentsRes.headers.get('content-range');
        if (contentRange) {
          var total = contentRange.split('/')[1];
          metrics.activeStudents = parseInt(total, 10) || 0;
        } else {
          var studentsData = await studentsRes.json();
          metrics.activeStudents = studentsData.length || 0;
        }
      }

      // Active routes count
      var routesUrl = SUPABASE_URL + '/rest/v1/transport_routes?select=id&is_active=eq.true';
      var routesRes = await fetch(routesUrl, {
        headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'count=exact' }),
      });
      if (routesRes.ok) {
        var routesRange = routesRes.headers.get('content-range');
        if (routesRange) {
          metrics.activeRoutes = parseInt(routesRange.split('/')[1], 10) || 0;
        } else {
          var routesData = await routesRes.json();
          metrics.activeRoutes = routesData.length || 0;
        }
      }

      // Fleet utilisation: vehicles assigned / total vehicles * 100
      var vehiclesUrl = SUPABASE_URL + '/rest/v1/transport_vehicles?select=id,status&status=neq.decommissioned';
      var vehiclesRes = await fetch(vehiclesUrl, { headers: getAuthHeaders() });
      if (vehiclesRes.ok) {
        var vehiclesData = await vehiclesRes.json();
        var totalVehicles = vehiclesData.length;
        var assignedVehicles = vehiclesData.filter(function (v) { return v.status === 'assigned'; }).length;
        metrics.fleetUtilisation = totalVehicles > 0
          ? Math.round((assignedVehicles / totalVehicles) * 100)
          : 0;
      }

      // Monthly revenue: sum of paid invoices for current month
      var now = new Date();
      var monthStart = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
      var invoicesUrl = SUPABASE_URL + '/rest/v1/transport_invoices?select=amount&status=eq.paid&billing_month=eq.' + monthStart;
      var invoicesRes = await fetch(invoicesUrl, { headers: getAuthHeaders() });
      if (invoicesRes.ok) {
        var invoicesData = await invoicesRes.json();
        metrics.monthlyRevenue = invoicesData.reduce(function (sum, inv) {
          return sum + parseFloat(inv.amount || 0);
        }, 0);
      }
    } catch (err) {
      console.error('[reports.js] Error fetching dashboard metrics:', err);
    }

    return metrics;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    setDefaultDates();
    bindEvents();
    loadRouteFilter();
    loadDashboardMetrics();
  }

  function setDefaultDates() {
    var now = new Date();
    var firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    elements.dateFrom.value = formatDateInput(firstOfMonth);
    elements.dateTo.value = formatDateInput(now);
  }

  function formatDateInput(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  async function loadRouteFilter() {
    var routes = await fetchRoutes();
    availableRoutes = routes;
    elements.routeFilter.innerHTML = '<option value="">All Routes</option>';
    routes.forEach(function (route) {
      var option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.route_name;
      elements.routeFilter.appendChild(option);
    });
  }

  async function loadDashboardMetrics() {
    var metrics = await fetchDashboardMetrics();
    elements.metricActiveStudents.textContent = metrics.activeStudents;
    elements.metricActiveRoutes.textContent = metrics.activeRoutes;
    elements.metricFleetUtilisation.textContent = metrics.fleetUtilisation + '%';
    elements.metricMonthlyRevenue.textContent = 'R ' + formatCurrency(metrics.monthlyRevenue);
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    elements.btnGenerate.addEventListener('click', handleGenerateReport);
    elements.btnExportCsv.addEventListener('click', handleExportCsv);
    elements.btnExportPdf.addEventListener('click', handleExportPdf);

    if (elements.logoutBtn) {
      elements.logoutBtn.addEventListener('click', handleLogout);
    }
  }

  function handleLogout() {
    localStorage.removeItem('phoenix-desktop-auth');
    window.location.href = 'login.html';
  }

  // ---------------------------------------------------------------------------
  // Generate Report
  // ---------------------------------------------------------------------------

  async function handleGenerateReport() {
    var reportType = elements.reportType.value;
    var dateFrom = elements.dateFrom.value;
    var dateTo = elements.dateTo.value;
    var routeId = elements.routeFilter.value || null;

    // Validate inputs
    if (!dateFrom || !dateTo) {
      showError('Please select both From and To dates.');
      return;
    }
    if (new Date(dateFrom) > new Date(dateTo)) {
      showError('From date must be before or equal to To date.');
      return;
    }

    // Clear previous state
    hideError();
    elements.reportDisplay.classList.add('hidden');
    elements.reportLoading.classList.remove('hidden');
    elements.btnGenerate.disabled = true;

    var payload = {
      report_type: reportType,
      start_date: dateFrom,
      end_date: dateTo,
    };
    if (routeId) {
      payload.route_id = routeId;
    }

    var result = await callGenerateReport(payload);

    elements.reportLoading.classList.add('hidden');
    elements.btnGenerate.disabled = false;

    if (!result.success) {
      showError(result.error || 'Failed to generate report.');
      return;
    }

    currentReportData = result.data;
    currentReportType = reportType;
    renderReport(reportType, result.data);
  }

  // ---------------------------------------------------------------------------
  // Render Report
  // ---------------------------------------------------------------------------

  function renderReport(reportType, data) {
    // Set title
    var titles = {
      daily_trip_summary: 'Daily Trip Summary',
      monthly_attendance: 'Monthly Attendance Report',
      monthly_revenue: 'Monthly Revenue Report',
    };
    elements.reportTitle.textContent = titles[reportType] || 'Report';
    elements.reportGeneratedDate.textContent = new Date().toLocaleDateString('en-ZA', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    // Render based on type
    switch (reportType) {
      case 'daily_trip_summary':
        renderDailyTripSummary(data);
        break;
      case 'monthly_attendance':
        renderMonthlyAttendance(data);
        break;
      case 'monthly_revenue':
        renderMonthlyRevenue(data);
        break;
      default:
        showError('Unknown report type.');
        return;
    }

    elements.reportDisplay.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // Daily Trip Summary
  // ---------------------------------------------------------------------------

  function renderDailyTripSummary(data) {
    var summary = data.summary || {};

    // Summary stats cards
    elements.reportSummaryStats.innerHTML = [
      createStatCard('Total Trips', summary.total_trips || 0),
      createStatCard('Completed', summary.completed_trips || 0),
      createStatCard('Cancelled', summary.cancelled_trips || 0),
      createStatCard('Avg Delay', (summary.average_delay_minutes || 0) + ' min'),
      createStatCard('In Progress', summary.in_progress_trips || 0),
    ].join('');

    // Daily breakdown table
    var dailyBreakdown = data.daily_breakdown || [];
    var tableHtml = '<div class="report-panel"><h4>Daily Breakdown</h4>';
    tableHtml += '<div class="table-container"><table class="data-table">';
    tableHtml += '<thead><tr>' +
      '<th>Date</th><th>Total</th><th>Completed</th><th>Cancelled</th><th>Avg Delay (min)</th>' +
      '</tr></thead><tbody>';

    if (dailyBreakdown.length === 0) {
      tableHtml += '<tr class="empty-row"><td colspan="5">No trip data for the selected period.</td></tr>';
    } else {
      dailyBreakdown.forEach(function (day) {
        tableHtml += '<tr>' +
          '<td>' + formatDisplayDate(day.date) + '</td>' +
          '<td>' + (day.total_trips || 0) + '</td>' +
          '<td>' + (day.completed || 0) + '</td>' +
          '<td>' + (day.cancelled || 0) + '</td>' +
          '<td>' + (day.average_delay_minutes != null ? day.average_delay_minutes.toFixed(1) : '—') + '</td>' +
          '</tr>';
      });
    }

    tableHtml += '</tbody></table></div></div>';
    elements.reportTablesContainer.innerHTML = tableHtml;
  }

  // ---------------------------------------------------------------------------
  // Monthly Attendance
  // ---------------------------------------------------------------------------

  function renderMonthlyAttendance(data) {
    var summary = data.summary || {};

    // Summary stats cards
    elements.reportSummaryStats.innerHTML = [
      createStatCard('Total Students', summary.total_students || 0),
      createStatCard('Total Trips', summary.total_trips || 0),
      createStatCard('Overall Rate', formatPercent(summary.overall_attendance_rate)),
      createStatCard('Boarded', summary.total_boarded || 0),
      createStatCard('Absent', summary.total_absent || 0),
    ].join('');

    var tablesHtml = '';

    // By route table
    var byRoute = data.by_route || [];
    tablesHtml += '<div class="report-panel"><h4>Attendance by Route</h4>';
    tablesHtml += '<div class="table-container"><table class="data-table">';
    tablesHtml += '<thead><tr>' +
      '<th>Route</th><th>Students</th><th>Trips</th><th>Boarded</th><th>Absent</th><th>Rate</th>' +
      '</tr></thead><tbody>';

    if (byRoute.length === 0) {
      tablesHtml += '<tr class="empty-row"><td colspan="6">No route attendance data.</td></tr>';
    } else {
      byRoute.forEach(function (row) {
        tablesHtml += '<tr>' +
          '<td>' + escapeHtml(row.route_name || '—') + '</td>' +
          '<td>' + (row.student_count || 0) + '</td>' +
          '<td>' + (row.trip_count || 0) + '</td>' +
          '<td>' + (row.boarded_count || 0) + '</td>' +
          '<td>' + (row.absent_count || 0) + '</td>' +
          '<td>' + formatPercent(row.attendance_rate) + '</td>' +
          '</tr>';
      });
    }
    tablesHtml += '</tbody></table></div></div>';

    // By student table
    var byStudent = data.by_student || [];
    tablesHtml += '<div class="report-panel"><h4>Attendance by Student</h4>';
    tablesHtml += '<div class="table-container"><table class="data-table">';
    tablesHtml += '<thead><tr>' +
      '<th>Student</th><th>Grade</th><th>Route</th><th>Boarded</th><th>Absent</th><th>Rate</th>' +
      '</tr></thead><tbody>';

    if (byStudent.length === 0) {
      tablesHtml += '<tr class="empty-row"><td colspan="6">No student attendance data.</td></tr>';
    } else {
      byStudent.forEach(function (row) {
        tablesHtml += '<tr>' +
          '<td>' + escapeHtml(row.student_name || '—') + '</td>' +
          '<td>' + escapeHtml(row.grade || '—') + '</td>' +
          '<td>' + escapeHtml(row.route_name || '—') + '</td>' +
          '<td>' + (row.boarded_count || 0) + '</td>' +
          '<td>' + (row.absent_count || 0) + '</td>' +
          '<td>' + formatPercent(row.attendance_rate) + '</td>' +
          '</tr>';
      });
    }
    tablesHtml += '</tbody></table></div></div>';

    elements.reportTablesContainer.innerHTML = tablesHtml;
  }

  // ---------------------------------------------------------------------------
  // Monthly Revenue
  // ---------------------------------------------------------------------------

  function renderMonthlyRevenue(data) {
    var summary = data.summary || {};

    // Summary stats cards
    elements.reportSummaryStats.innerHTML = [
      createStatCard('Invoiced Total', 'R ' + formatCurrency(summary.invoiced_total || 0)),
      createStatCard('Collected', 'R ' + formatCurrency(summary.collected_total || 0)),
      createStatCard('Outstanding', 'R ' + formatCurrency(summary.outstanding_total || 0)),
      createStatCard('Collection Rate', formatPercent(summary.collection_rate)),
      createStatCard('Total Invoices', summary.total_invoices || 0),
    ].join('');

    // By route table
    var byRoute = data.by_route || [];
    var tableHtml = '<div class="report-panel"><h4>Revenue by Route</h4>';
    tableHtml += '<div class="table-container"><table class="data-table">';
    tableHtml += '<thead><tr>' +
      '<th>Route</th><th>Students</th><th>Invoiced</th><th>Collected</th><th>Outstanding</th><th>Rate</th>' +
      '</tr></thead><tbody>';

    if (byRoute.length === 0) {
      tableHtml += '<tr class="empty-row"><td colspan="6">No revenue data for the selected period.</td></tr>';
    } else {
      byRoute.forEach(function (row) {
        tableHtml += '<tr>' +
          '<td>' + escapeHtml(row.route_name || '—') + '</td>' +
          '<td>' + (row.student_count || 0) + '</td>' +
          '<td>R ' + formatCurrency(row.invoiced_total || 0) + '</td>' +
          '<td>R ' + formatCurrency(row.collected_total || 0) + '</td>' +
          '<td>R ' + formatCurrency(row.outstanding || 0) + '</td>' +
          '<td>' + formatPercent(row.collection_rate) + '</td>' +
          '</tr>';
      });
    }
    tableHtml += '</tbody></table></div></div>';

    elements.reportTablesContainer.innerHTML = tableHtml;
  }

  // ---------------------------------------------------------------------------
  // Export — CSV
  // ---------------------------------------------------------------------------

  function handleExportCsv() {
    if (!currentReportData) return;

    var csvContent = '';
    var filename = 'transport_report_' + currentReportType + '_' + elements.dateFrom.value + '.csv';

    switch (currentReportType) {
      case 'daily_trip_summary':
        csvContent = buildDailyTripCsv(currentReportData);
        break;
      case 'monthly_attendance':
        csvContent = buildMonthlyAttendanceCsv(currentReportData);
        break;
      case 'monthly_revenue':
        csvContent = buildMonthlyRevenueCsv(currentReportData);
        break;
      default:
        return;
    }

    downloadCsv(csvContent, filename);
  }

  function buildDailyTripCsv(data) {
    var lines = ['Date,Total Trips,Completed,Cancelled,Avg Delay (min)'];
    var dailyBreakdown = data.daily_breakdown || [];
    dailyBreakdown.forEach(function (day) {
      lines.push([
        day.date,
        day.total_trips || 0,
        day.completed || 0,
        day.cancelled || 0,
        day.average_delay_minutes != null ? day.average_delay_minutes.toFixed(1) : '',
      ].join(','));
    });
    return lines.join('\n');
  }

  function buildMonthlyAttendanceCsv(data) {
    var lines = ['Section: By Route'];
    lines.push('Route,Students,Trips,Boarded,Absent,Rate');
    (data.by_route || []).forEach(function (row) {
      lines.push([
        csvEscape(row.route_name || ''),
        row.student_count || 0,
        row.trip_count || 0,
        row.boarded_count || 0,
        row.absent_count || 0,
        row.attendance_rate != null ? (row.attendance_rate * 100).toFixed(1) + '%' : '',
      ].join(','));
    });

    lines.push('');
    lines.push('Section: By Student');
    lines.push('Student,Grade,Route,Boarded,Absent,Rate');
    (data.by_student || []).forEach(function (row) {
      lines.push([
        csvEscape(row.student_name || ''),
        csvEscape(row.grade || ''),
        csvEscape(row.route_name || ''),
        row.boarded_count || 0,
        row.absent_count || 0,
        row.attendance_rate != null ? (row.attendance_rate * 100).toFixed(1) + '%' : '',
      ].join(','));
    });

    return lines.join('\n');
  }

  function buildMonthlyRevenueCsv(data) {
    var lines = ['Route,Students,Invoiced,Collected,Outstanding,Collection Rate'];
    (data.by_route || []).forEach(function (row) {
      lines.push([
        csvEscape(row.route_name || ''),
        row.student_count || 0,
        row.invoiced_total || 0,
        row.collected_total || 0,
        row.outstanding || 0,
        row.collection_rate != null ? (row.collection_rate * 100).toFixed(1) + '%' : '',
      ].join(','));
    });
    return lines.join('\n');
  }

  function downloadCsv(csvContent, filename) {
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    var str = String(value);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ---------------------------------------------------------------------------
  // Export — PDF (via window.print with print-specific styles)
  // ---------------------------------------------------------------------------

  function handleExportPdf() {
    if (!currentReportData) return;

    // Use Electron's printToPDF if available, else fallback to window.print
    if (window.electronAPI && window.electronAPI.printToPDF) {
      var filename = 'Phoenix_Transport_' + currentReportType + '_' + elements.dateFrom.value + '.pdf';
      window.electronAPI.printToPDF(filename);
    } else {
      window.print();
    }
  }

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------

  function createStatCard(label, value) {
    return '<div class="report-stat">' +
      '<span class="stat-label">' + escapeHtml(label) + '</span>' +
      '<span class="stat-value">' + escapeHtml(String(value)) + '</span>' +
      '</div>';
  }

  function showError(message) {
    elements.reportError.textContent = message;
    elements.reportError.classList.remove('hidden');
  }

  function hideError() {
    elements.reportError.textContent = '';
    elements.reportError.classList.add('hidden');
  }

  function formatCurrency(value) {
    return Number(value || 0).toLocaleString('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatPercent(value) {
    if (value == null || isNaN(value)) return '—';
    return (Number(value) * 100).toFixed(1) + '%';
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr) return '—';
    try {
      var date = new Date(dateStr + 'T00:00:00');
      return date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
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
