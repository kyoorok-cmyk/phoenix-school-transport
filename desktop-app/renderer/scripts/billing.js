/**
 * Billing Page Controller
 *
 * Vanilla JS controller for the billing and invoicing page.
 * Handles invoice generation, payment recording, fee configuration,
 * and invoice status dashboard via Supabase Edge Functions.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var invoices = [];
  var routes = [];
  var students = [];
  var pendingInvoicesForPayment = [];

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // Stats
    statPending: document.getElementById('stat-pending'),
    statOverdue: document.getElementById('stat-overdue'),
    statPaid: document.getElementById('stat-paid'),
    statOutstanding: document.getElementById('stat-outstanding'),

    // Tabs
    tabButtons: document.querySelectorAll('.billing-tabs .tab-btn'),

    // Invoice actions
    billingMonth: document.getElementById('billing-month'),
    btnGenerateInvoices: document.getElementById('btn-generate-invoices'),
    btnRecordPayment: document.getElementById('btn-record-payment'),
  };

  // Add remaining DOM refs
  Object.assign(elements, {
    // Filters
    invoiceSearch: document.getElementById('invoice-search'),
    filterStatus: document.getElementById('filter-status'),
    filterMonth: document.getElementById('filter-month'),
    filterRoute: document.getElementById('filter-route'),

    // Tables
    invoiceTableBody: document.getElementById('invoice-table-body'),
    feeTableBody: document.getElementById('fee-table-body'),

    // Payment modal
    paymentModal: document.getElementById('payment-modal'),
    paymentForm: document.getElementById('payment-form'),
    paymentInvoice: document.getElementById('payment-invoice'),
    paymentAmount: document.getElementById('payment-amount'),
    paymentMethod: document.getElementById('payment-method'),
    paymentDate: document.getElementById('payment-date'),
    paymentReference: document.getElementById('payment-reference'),
    paymentFormError: document.getElementById('payment-form-error'),
    selectedInvoiceInfo: document.getElementById('selected-invoice-info'),
    invoiceInfoText: document.getElementById('invoice-info-text'),
    btnClosePaymentModal: document.getElementById('btn-close-payment-modal'),
    btnCancelPayment: document.getElementById('btn-cancel-payment'),

    // Toast
    toast: document.getElementById('toast'),

    // Logout
    logoutBtn: document.getElementById('logout-btn'),
  });

  // ---------------------------------------------------------------------------
  // Service Interface
  // ---------------------------------------------------------------------------

  function getConfig() {
    return window.phoenixConfig || {};
  }

  function getAuthHeaders() {
    var config = getConfig();
    var token = config.accessToken || config.supabaseAnonKey || '';
    return {
      'apikey': config.supabaseAnonKey || '',
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    };
  }

  var billingService = {
    /**
     * Fetch invoices from Supabase with optional filters.
     */
    getInvoices: async function (filters) {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: true, data: [] };
      try {
        var url = config.supabaseUrl + '/rest/v1/transport_invoices?select=*,transport_students(full_name,assigned_route_id),transport_routes:transport_students(transport_routes(route_name))&order=created_at.desc';

        if (filters && filters.status) {
          url += '&status=eq.' + filters.status;
        }
        if (filters && filters.billing_month) {
          url += '&billing_month=eq.' + filters.billing_month + '-01';
        }

        var response = await fetch(url, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        return { success: true, data: data || [] };
      } catch (e) {
        console.error('[billing] getInvoices error:', e);
        return { success: false, error: 'Failed to fetch invoices' };
      }
    },

    /**
     * Generate invoices for a billing month via Edge Function.
     */
    generateInvoices: async function (billingMonth) {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: false, error: 'Service not connected' };
      try {
        var response = await fetch(config.supabaseUrl + '/functions/v1/generate-invoice', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ billing_month: billingMonth }),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true, data: result };
      } catch (e) {
        console.error('[billing] generateInvoices error:', e);
        return { success: false, error: 'Failed to generate invoices' };
      }
    },

    /**
     * Record a payment against an invoice via Edge Function.
     */
    recordPayment: async function (paymentData) {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: false, error: 'Service not connected' };
      try {
        var response = await fetch(config.supabaseUrl + '/functions/v1/record-payment', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(paymentData),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true, data: result };
      } catch (e) {
        console.error('[billing] recordPayment error:', e);
        return { success: false, error: 'Failed to record payment' };
      }
    },

    /**
     * Fetch all routes for filter dropdown and fee config.
     */
    getRoutes: async function () {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: true, data: [] };
      try {
        var url = config.supabaseUrl + '/rest/v1/transport_routes?select=id,route_name,school_name,monthly_fee,is_active&order=route_name.asc';
        var response = await fetch(url, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        return { success: true, data: data || [] };
      } catch (e) {
        console.error('[billing] getRoutes error:', e);
        return { success: false, error: 'Failed to fetch routes' };
      }
    },

    /**
     * Update monthly fee for a route.
     */
    updateRouteFee: async function (routeId, monthlyFee) {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: false, error: 'Service not connected' };
      try {
        var response = await fetch(config.supabaseUrl + '/functions/v1/manage-routes', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            action: 'update',
            routeId: routeId,
            route: { monthly_fee: monthlyFee },
          }),
        });
        var result = await response.json();
        if (result.error) return { success: false, error: result.error };
        return { success: true, data: result };
      } catch (e) {
        console.error('[billing] updateRouteFee error:', e);
        return { success: false, error: 'Failed to update fee' };
      }
    },

    /**
     * Get student count per route for fee config table.
     */
    getStudentCountsByRoute: async function () {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: true, data: {} };
      try {
        var url = config.supabaseUrl + '/rest/v1/transport_students?select=assigned_route_id&status=eq.active';
        var response = await fetch(url, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        var counts = {};
        (data || []).forEach(function (s) {
          if (s.assigned_route_id) {
            counts[s.assigned_route_id] = (counts[s.assigned_route_id] || 0) + 1;
          }
        });
        return { success: true, data: counts };
      } catch (e) {
        console.error('[billing] getStudentCountsByRoute error:', e);
        return { success: false, error: 'Failed to fetch student counts' };
      }
    },

    /**
     * Get pending/unpaid invoices for the payment dropdown.
     */
    getPendingInvoices: async function () {
      var config = getConfig();
      if (!config.supabaseUrl) return { success: true, data: [] };
      try {
        var url = config.supabaseUrl + '/rest/v1/transport_invoices?select=*,transport_students(full_name)&status=in.(pending,overdue)&order=due_date.asc';
        var response = await fetch(url, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        return { success: true, data: data || [] };
      } catch (e) {
        console.error('[billing] getPendingInvoices error:', e);
        return { success: false, error: 'Failed to fetch pending invoices' };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    setDefaultDates();
    bindEvents();
    loadRoutes();
    loadInvoices();
    loadDashboardStats();
  }

  function setDefaultDates() {
    var now = new Date();
    var monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    elements.billingMonth.value = monthStr;
    elements.paymentDate.value = formatISODate(now);
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // Tab switching
    elements.tabButtons.forEach(function (btn) {
      btn.addEventListener('click', handleTabSwitch);
    });

    // Generate invoices
    elements.btnGenerateInvoices.addEventListener('click', handleGenerateInvoices);

    // Record payment modal
    elements.btnRecordPayment.addEventListener('click', openPaymentModal);
    elements.btnClosePaymentModal.addEventListener('click', closePaymentModal);
    elements.btnCancelPayment.addEventListener('click', closePaymentModal);
    elements.paymentForm.addEventListener('submit', handlePaymentSubmit);
    elements.paymentInvoice.addEventListener('change', handleInvoiceSelect);

    // Filters
    elements.invoiceSearch.addEventListener('input', debounce(applyFilters, 300));
    elements.filterStatus.addEventListener('change', applyFilters);
    elements.filterMonth.addEventListener('change', applyFilters);
    elements.filterRoute.addEventListener('change', applyFilters);

    // Logout
    if (elements.logoutBtn) {
      elements.logoutBtn.addEventListener('click', handleLogout);
    }
  }

  // ---------------------------------------------------------------------------
  // Tab Switching
  // ---------------------------------------------------------------------------

  function handleTabSwitch(e) {
    var targetTab = e.target.getAttribute('data-tab');
    if (!targetTab) return;

    // Deactivate all tabs and content
    elements.tabButtons.forEach(function (btn) { btn.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (tc) { tc.classList.remove('active'); });

    // Activate selected
    e.target.classList.add('active');
    var tabContent = document.getElementById(targetTab);
    if (tabContent) tabContent.classList.add('active');

    // Load fee config if switching to that tab
    if (targetTab === 'fee-config-tab') {
      loadFeeConfig();
    }
  }

  // ---------------------------------------------------------------------------
  // Load Data
  // ---------------------------------------------------------------------------

  async function loadRoutes() {
    var result = await billingService.getRoutes();
    if (result.success) {
      routes = result.data || [];
      populateRouteFilter();
    }
  }

  function populateRouteFilter() {
    var select = elements.filterRoute;
    // Keep "All Routes" option
    select.innerHTML = '<option value="">All Routes</option>';
    routes.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.route_name;
      select.appendChild(opt);
    });
  }

  async function loadInvoices() {
    var filters = getActiveFilters();
    var result = await billingService.getInvoices(filters);

    if (result.success) {
      invoices = result.data || [];
      applyClientSideFilters();
      loadDashboardStats();
    } else {
      elements.invoiceTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="7">Failed to load invoices.</td></tr>';
    }
  }

  function getActiveFilters() {
    var filters = {};
    var status = elements.filterStatus.value;
    var month = elements.filterMonth.value;

    if (status) filters.status = status;
    if (month) filters.billing_month = month;

    return filters;
  }

  function applyFilters() {
    loadInvoices();
  }

  function applyClientSideFilters() {
    var search = (elements.invoiceSearch.value || '').trim().toLowerCase();
    var routeId = elements.filterRoute.value;

    var filtered = invoices;

    if (search) {
      filtered = filtered.filter(function (inv) {
        var studentName = getStudentName(inv).toLowerCase();
        var invoiceNum = (inv.invoice_number || '').toLowerCase();
        return studentName.indexOf(search) !== -1 || invoiceNum.indexOf(search) !== -1;
      });
    }

    if (routeId) {
      filtered = filtered.filter(function (inv) {
        var student = inv.transport_students;
        return student && student.assigned_route_id === routeId;
      });
    }

    renderInvoiceTable(filtered);
  }

  // ---------------------------------------------------------------------------
  // Dashboard Stats
  // ---------------------------------------------------------------------------

  function loadDashboardStats() {
    var pending = 0;
    var overdue = 0;
    var paid = 0;
    var outstanding = 0;

    var now = new Date();
    var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    invoices.forEach(function (inv) {
      var amount = parseFloat(inv.amount) || 0;
      if (inv.status === 'pending') {
        pending += amount;
        outstanding += amount;
      } else if (inv.status === 'overdue') {
        overdue += amount;
        outstanding += amount;
      } else if (inv.status === 'paid') {
        // Count paid this month only
        var billingMonth = (inv.billing_month || '').substring(0, 7);
        if (billingMonth === currentMonth) {
          paid += amount;
        }
      }
    });

    elements.statPending.textContent = 'R ' + formatCurrency(pending);
    elements.statOverdue.textContent = 'R ' + formatCurrency(overdue);
    elements.statPaid.textContent = 'R ' + formatCurrency(paid);
    elements.statOutstanding.textContent = 'R ' + formatCurrency(outstanding);
  }

  // ---------------------------------------------------------------------------
  // Render Invoice Table
  // ---------------------------------------------------------------------------

  function renderInvoiceTable(data) {
    if (!data || data.length === 0) {
      elements.invoiceTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="7">No invoices found.</td></tr>';
      return;
    }

    elements.invoiceTableBody.innerHTML = data.map(function (inv) {
      var studentName = getStudentName(inv);
      var routeName = getRouteName(inv);
      return (
        '<tr data-id="' + inv.id + '">' +
        '<td>' + escapeHtml(inv.invoice_number) + '</td>' +
        '<td>' + escapeHtml(studentName) + '</td>' +
        '<td>' + escapeHtml(routeName) + '</td>' +
        '<td>R ' + formatCurrency(inv.amount) + '</td>' +
        '<td>' + formatDate(inv.due_date) + '</td>' +
        '<td>' + getStatusBadge(inv.status) + '</td>' +
        '<td class="action-links">' +
          (inv.status !== 'paid' && inv.status !== 'cancelled'
            ? '<button class="btn btn-sm btn-primary btn-pay-invoice" data-id="' + inv.id + '">Pay</button>'
            : '') +
        '</td>' +
        '</tr>'
      );
    }).join('');

    // Bind pay buttons
    elements.invoiceTableBody.querySelectorAll('.btn-pay-invoice').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var invoiceId = this.getAttribute('data-id');
        openPaymentModalForInvoice(invoiceId);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Generate Invoices
  // ---------------------------------------------------------------------------

  async function handleGenerateInvoices() {
    var month = elements.billingMonth.value;
    if (!month) {
      showToast('Please select a billing month.', 'error');
      return;
    }

    elements.btnGenerateInvoices.disabled = true;
    elements.btnGenerateInvoices.textContent = 'Generating...';

    var result = await billingService.generateInvoices(month);

    elements.btnGenerateInvoices.disabled = false;
    elements.btnGenerateInvoices.textContent = 'Generate Invoices';

    if (result.success) {
      var count = (result.data && result.data.invoices_created) || 0;
      showToast('Generated ' + count + ' invoice(s) for ' + month + '.', 'success');
      loadInvoices();
    } else {
      showToast(result.error || 'Failed to generate invoices.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Payment Modal
  // ---------------------------------------------------------------------------

  async function openPaymentModal() {
    resetPaymentForm();
    await loadPendingInvoicesDropdown();
    elements.paymentModal.classList.remove('hidden');
  }

  function openPaymentModalForInvoice(invoiceId) {
    resetPaymentForm();
    loadPendingInvoicesDropdown().then(function () {
      elements.paymentInvoice.value = invoiceId;
      handleInvoiceSelect();
      elements.paymentModal.classList.remove('hidden');
    });
  }

  function closePaymentModal() {
    elements.paymentModal.classList.add('hidden');
    resetPaymentForm();
  }

  function resetPaymentForm() {
    elements.paymentForm.reset();
    elements.paymentDate.value = formatISODate(new Date());
    hidePaymentError();
    elements.selectedInvoiceInfo.classList.add('hidden');
  }

  async function loadPendingInvoicesDropdown() {
    var result = await billingService.getPendingInvoices();
    if (result.success) {
      pendingInvoicesForPayment = result.data || [];
      var select = elements.paymentInvoice;
      select.innerHTML = '<option value="">Select an invoice...</option>';
      pendingInvoicesForPayment.forEach(function (inv) {
        var studentName = inv.transport_students ? inv.transport_students.full_name : 'Unknown';
        var opt = document.createElement('option');
        opt.value = inv.id;
        opt.textContent = inv.invoice_number + ' — ' + studentName + ' (R ' + formatCurrency(inv.amount) + ')';
        select.appendChild(opt);
      });
    }
  }

  function handleInvoiceSelect() {
    var invoiceId = elements.paymentInvoice.value;
    if (!invoiceId) {
      elements.selectedInvoiceInfo.classList.add('hidden');
      return;
    }

    var inv = pendingInvoicesForPayment.find(function (i) { return i.id === invoiceId; });
    if (inv) {
      var studentName = inv.transport_students ? inv.transport_students.full_name : 'Unknown';
      elements.invoiceInfoText.textContent =
        'Student: ' + studentName + ' | Amount Due: R ' + formatCurrency(inv.amount) +
        ' | Due: ' + formatDate(inv.due_date) + ' | Status: ' + inv.status;
      elements.selectedInvoiceInfo.classList.remove('hidden');
      // Pre-fill amount
      elements.paymentAmount.value = inv.amount;
    }
  }

  async function handlePaymentSubmit(e) {
    e.preventDefault();
    hidePaymentError();

    var invoiceId = elements.paymentInvoice.value;
    var amount = parseFloat(elements.paymentAmount.value);
    var method = elements.paymentMethod.value;
    var date = elements.paymentDate.value;
    var reference = elements.paymentReference.value.trim();

    // Validation
    if (!invoiceId) {
      showPaymentError('Please select an invoice.');
      return;
    }
    if (!amount || amount <= 0) {
      showPaymentError('Please enter a valid amount greater than zero.');
      return;
    }
    if (!method) {
      showPaymentError('Please select a payment method.');
      return;
    }
    if (!date) {
      showPaymentError('Please select a payment date.');
      return;
    }

    var paymentData = {
      invoice_id: invoiceId,
      amount: amount,
      payment_method: method,
      payment_date: date,
    };
    if (reference) {
      paymentData.reference = reference;
    }

    var result = await billingService.recordPayment(paymentData);

    if (result.success) {
      closePaymentModal();
      showToast('Payment recorded successfully.', 'success');
      loadInvoices();
    } else {
      showPaymentError(result.error || 'Failed to record payment.');
    }
  }

  // ---------------------------------------------------------------------------
  // Fee Configuration
  // ---------------------------------------------------------------------------

  async function loadFeeConfig() {
    var routeResult = await billingService.getRoutes();
    var countResult = await billingService.getStudentCountsByRoute();

    if (!routeResult.success) {
      elements.feeTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="5">Failed to load routes.</td></tr>';
      return;
    }

    var allRoutes = routeResult.data || [];
    var counts = (countResult.success && countResult.data) || {};

    if (allRoutes.length === 0) {
      elements.feeTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="5">No routes configured.</td></tr>';
      return;
    }

    elements.feeTableBody.innerHTML = allRoutes.map(function (route) {
      var studentCount = counts[route.id] || 0;
      return (
        '<tr data-route-id="' + route.id + '">' +
        '<td>' + escapeHtml(route.route_name) + '</td>' +
        '<td>' + escapeHtml(route.school_name) + '</td>' +
        '<td>' + studentCount + '</td>' +
        '<td><input type="number" class="fee-input" data-route-id="' + route.id + '" value="' + (route.monthly_fee || 0) + '" min="0" step="0.01" /></td>' +
        '<td><button class="btn btn-sm btn-primary btn-save-fee" data-route-id="' + route.id + '">Save</button> <span class="fee-saved" id="fee-saved-' + route.id + '">✓ Saved</span></td>' +
        '</tr>'
      );
    }).join('');

    // Bind save buttons
    elements.feeTableBody.querySelectorAll('.btn-save-fee').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var routeId = this.getAttribute('data-route-id');
        handleSaveFee(routeId);
      });
    });
  }

  async function handleSaveFee(routeId) {
    var input = elements.feeTableBody.querySelector('.fee-input[data-route-id="' + routeId + '"]');
    var savedIndicator = document.getElementById('fee-saved-' + routeId);
    if (!input) return;

    var fee = parseFloat(input.value);
    if (isNaN(fee) || fee < 0) {
      showToast('Please enter a valid fee amount.', 'error');
      return;
    }

    var result = await billingService.updateRouteFee(routeId, fee);
    if (result.success) {
      // Show saved indicator briefly
      if (savedIndicator) {
        savedIndicator.classList.add('show');
        setTimeout(function () { savedIndicator.classList.remove('show'); }, 2000);
      }
      // Update local routes cache
      var route = routes.find(function (r) { return r.id === routeId; });
      if (route) route.monthly_fee = fee;
    } else {
      showToast(result.error || 'Failed to update fee.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getStudentName(invoice) {
    if (invoice.transport_students && invoice.transport_students.full_name) {
      return invoice.transport_students.full_name;
    }
    return 'Unknown';
  }

  function getRouteName(invoice) {
    // The joined route data varies by Supabase response shape
    if (invoice.transport_students && invoice.transport_students.transport_routes) {
      var routeData = invoice.transport_students.transport_routes;
      if (routeData && routeData.route_name) return routeData.route_name;
    }
    // Fallback: look up from loaded routes
    if (invoice.transport_students && invoice.transport_students.assigned_route_id) {
      var route = routes.find(function (r) { return r.id === invoice.transport_students.assigned_route_id; });
      if (route) return route.route_name;
    }
    return '—';
  }

  function getStatusBadge(status) {
    var cls = 'badge-' + status;
    var label = status.charAt(0).toUpperCase() + status.slice(1);
    return '<span class="invoice-badge ' + cls + '">' + label + '</span>';
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatCurrency(value) {
    return Number(value || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    var date = new Date(isoString);
    return date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatISODate(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
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
  // Error Helpers
  // ---------------------------------------------------------------------------

  function showPaymentError(msg) {
    elements.paymentFormError.textContent = msg;
    elements.paymentFormError.classList.remove('hidden');
  }

  function hidePaymentError() {
    elements.paymentFormError.textContent = '';
    elements.paymentFormError.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Toast Notifications
  // ---------------------------------------------------------------------------

  function showToast(message, type) {
    var toast = elements.toast;
    toast.textContent = message;
    toast.className = 'toast toast-' + (type || 'success') + ' show';
    setTimeout(function () {
      toast.classList.remove('show');
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  function handleLogout() {
    if (window.__phoenixServices && window.__phoenixServices.signOut) {
      window.__phoenixServices.signOut();
    } else {
      window.location.href = 'login.html';
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    function bootstrap() {
      if (window.__phoenixServices) {
        // Override service methods if provided by the bundle
        if (window.__phoenixServices.getInvoices) {
          billingService.getInvoices = window.__phoenixServices.getInvoices;
        }
        if (window.__phoenixServices.generateInvoices) {
          billingService.generateInvoices = window.__phoenixServices.generateInvoices;
        }
        if (window.__phoenixServices.recordPayment) {
          billingService.recordPayment = window.__phoenixServices.recordPayment;
        }
      }
      init();
    }

    if (window.__phoenixServicesReady) {
      bootstrap();
    } else {
      window.addEventListener('phoenixServicesReady', bootstrap);
      // Fallback: if event never fires, bootstrap after short delay
      setTimeout(function () {
        if (!window.__phoenixServicesReady) bootstrap();
      }, 1000);
    }
  });

})();
