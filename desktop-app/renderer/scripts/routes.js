/**
 * Routes Page Controller
 *
 * Vanilla JS controller for the Route Management page.
 * Handles route CRUD, stop management, drag-and-drop reordering,
 * and interactive Leaflet map display.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var routes = [];
  var selectedRoute = null;
  var selectedRouteStops = [];
  var editingRouteId = null;
  var editingStopId = null;
  var deleteTarget = null; // { type: 'route'|'stop', id: '...' }
  var map = null;
  var mapMarkers = [];
  var mapPolyline = null;
  var pickingCoords = false;

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    // List view
    routeListView: document.getElementById('route-list-view'),
    routeTableBody: document.getElementById('route-table-body'),
    searchInput: document.getElementById('search-input'),
    statusFilter: document.getElementById('status-filter'),
    btnNewRoute: document.getElementById('btn-new-route'),

    // Detail view
    routeDetailView: document.getElementById('route-detail-view'),
    btnBackToList: document.getElementById('btn-back-to-list'),
    btnEditRoute: document.getElementById('btn-edit-route'),
    btnDeleteRoute: document.getElementById('btn-delete-route'),
    detailRouteName: document.getElementById('detail-route-name'),
    detailSchool: document.getElementById('detail-school'),
    detailTravel: document.getElementById('detail-travel'),
    detailFee: document.getElementById('detail-fee'),
    detailStatus: document.getElementById('detail-status'),
    detailStopCount: document.getElementById('detail-stop-count'),
    stopsList: document.getElementById('stops-list'),
    btnAddStop: document.getElementById('btn-add-stop'),

    // Route form modal
    routeModal: document.getElementById('route-modal'),
    routeModalTitle: document.getElementById('route-modal-title'),
    routeForm: document.getElementById('route-form'),
    routeFormError: document.getElementById('route-form-error'),
    btnCloseRouteModal: document.getElementById('btn-close-route-modal'),
    btnCancelRouteForm: document.getElementById('btn-cancel-route-form'),
    btnSaveRoute: document.getElementById('btn-save-route'),

    // Stop form modal
    stopModal: document.getElementById('stop-modal'),
    stopModalTitle: document.getElementById('stop-modal-title'),
    stopForm: document.getElementById('stop-form'),
    stopFormError: document.getElementById('stop-form-error'),
    btnCloseStopModal: document.getElementById('btn-close-stop-modal'),
    btnCancelStopForm: document.getElementById('btn-cancel-stop-form'),
    btnSaveStop: document.getElementById('btn-save-stop'),

    // Delete modal
    deleteModal: document.getElementById('delete-modal'),
    deleteMessage: document.getElementById('delete-message'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete'),
  };

  // ---------------------------------------------------------------------------
  // Service — calls the manage-routes Edge Function
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

  async function callManageRoutes(payload) {
    try {
      var response = await fetch(SUPABASE_URL + '/functions/v1/manage-routes', {
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
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    bindEvents();
    loadRoutes();
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // Search and filter
    elements.searchInput.addEventListener('input', debounce(handleSearch, 300));
    elements.statusFilter.addEventListener('change', loadRoutes);

    // New route
    elements.btnNewRoute.addEventListener('click', openNewRouteForm);

    // Detail view
    elements.btnBackToList.addEventListener('click', showListView);
    elements.btnEditRoute.addEventListener('click', openEditRouteForm);
    elements.btnDeleteRoute.addEventListener('click', function () {
      openDeleteConfirm('route', selectedRoute.id, 'Are you sure you want to delete this route and all its stops?');
    });

    // Route form modal
    elements.btnCloseRouteModal.addEventListener('click', closeRouteModal);
    elements.btnCancelRouteForm.addEventListener('click', closeRouteModal);
    elements.btnSaveRoute.addEventListener('click', handleSaveRoute);

    // Stop management
    elements.btnAddStop.addEventListener('click', openNewStopForm);
    elements.btnCloseStopModal.addEventListener('click', closeStopModal);
    elements.btnCancelStopForm.addEventListener('click', closeStopModal);
    elements.btnSaveStop.addEventListener('click', handleSaveStop);

    // Delete modal
    elements.btnCancelDelete.addEventListener('click', closeDeleteModal);
    elements.btnConfirmDelete.addEventListener('click', handleConfirmDelete);
  }

  // ---------------------------------------------------------------------------
  // Route List
  // ---------------------------------------------------------------------------

  async function loadRoutes() {
    var statusVal = elements.statusFilter.value;
    var payload = { action: 'list_routes' };
    if (statusVal === 'active') payload.is_active = true;
    if (statusVal === 'inactive') payload.is_active = false;

    var result = await callManageRoutes(payload);
    if (result.success && result.data) {
      routes = Array.isArray(result.data) ? result.data : (result.data.routes || []);
      renderRouteTable(routes);
    } else {
      // Fallback: try direct Supabase query
      await loadRoutesDirectly();
    }
  }

  async function loadRoutesDirectly() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_routes?select=*,transport_stops(id)&order=route_name.asc';
      var statusVal = elements.statusFilter.value;
      if (statusVal === 'active') url += '&is_active=eq.true';
      if (statusVal === 'inactive') url += '&is_active=eq.false';

      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        var data = await response.json();
        routes = data.map(function (r) {
          r.stop_count = r.transport_stops ? r.transport_stops.length : 0;
          return r;
        });
        renderRouteTable(routes);
      } else {
        elements.routeTableBody.innerHTML =
          '<tr class="empty-row"><td colspan="7">Failed to load routes.</td></tr>';
      }
    } catch (err) {
      elements.routeTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="7">Error: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function handleSearch() {
    var query = elements.searchInput.value.trim().toLowerCase();
    if (!query) {
      renderRouteTable(routes);
      return;
    }
    var filtered = routes.filter(function (r) {
      return r.route_name.toLowerCase().indexOf(query) !== -1 ||
        r.school_name.toLowerCase().indexOf(query) !== -1;
    });
    renderRouteTable(filtered);
  }

  function renderRouteTable(data) {
    if (!data || data.length === 0) {
      elements.routeTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="7">No routes found.</td></tr>';
      return;
    }

    elements.routeTableBody.innerHTML = data.map(function (route) {
      var statusClass = route.is_active ? 'status-active-route' : 'status-inactive-route';
      var statusLabel = route.is_active ? 'Active' : 'Inactive';
      var stopCount = route.stop_count !== undefined ? route.stop_count :
        (route.transport_stops ? route.transport_stops.length : '—');
      return (
        '<tr data-id="' + route.id + '">' +
        '<td><a href="#" class="client-link route-link" data-id="' + route.id + '">' + escapeHtml(route.route_name) + '</a></td>' +
        '<td>' + escapeHtml(route.school_name) + '</td>' +
        '<td>' + route.estimated_travel_minutes + ' min</td>' +
        '<td>R ' + Number(route.monthly_fee).toFixed(2) + '</td>' +
        '<td>' + stopCount + '</td>' +
        '<td><span class="status-badge ' + statusClass + '">' + statusLabel + '</span></td>' +
        '<td class="action-links">' +
          '<button class="btn btn-sm btn-secondary btn-view-route" data-id="' + route.id + '">View</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('');

    // Bind row click events
    var links = elements.routeTableBody.querySelectorAll('.route-link, .btn-view-route');
    links.forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var id = this.getAttribute('data-id');
        showRouteDetail(id);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Route Detail View
  // ---------------------------------------------------------------------------

  async function showRouteDetail(routeId) {
    var route = routes.find(function (r) { return r.id === routeId; });
    if (!route) {
      alert('Route not found');
      return;
    }
    selectedRoute = route;

    // Load stops for this route
    await loadStops(routeId);

    renderRouteDetail();
    elements.routeListView.classList.add('hidden');
    elements.routeDetailView.classList.remove('hidden');

    // Init map after DOM is visible
    setTimeout(initMap, 100);
  }

  function showListView() {
    elements.routeDetailView.classList.add('hidden');
    elements.routeListView.classList.remove('hidden');
    selectedRoute = null;
    selectedRouteStops = [];
    if (map) {
      map.remove();
      map = null;
    }
    loadRoutes();
  }

  async function loadStops(routeId) {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_stops?route_id=eq.' + routeId + '&order=stop_order.asc';
      var response = await fetch(url, { headers: getAuthHeaders() });
      if (response.ok) {
        selectedRouteStops = await response.json();
      } else {
        selectedRouteStops = [];
      }
    } catch (err) {
      selectedRouteStops = [];
    }
  }

  function renderRouteDetail() {
    if (!selectedRoute) return;
    elements.detailRouteName.textContent = selectedRoute.route_name;
    elements.detailSchool.textContent = selectedRoute.school_name;
    elements.detailTravel.textContent = selectedRoute.estimated_travel_minutes + ' minutes';
    elements.detailFee.textContent = 'R ' + Number(selectedRoute.monthly_fee).toFixed(2);
    elements.detailStatus.innerHTML = selectedRoute.is_active
      ? '<span class="status-badge status-active-route">Active</span>'
      : '<span class="status-badge status-inactive-route">Inactive</span>';
    elements.detailStopCount.textContent = selectedRouteStops.length;

    renderStopsList();
  }

  // ---------------------------------------------------------------------------
  // Stops List with Drag-and-Drop + Up/Down Reordering
  // ---------------------------------------------------------------------------

  function renderStopsList() {
    if (!selectedRouteStops || selectedRouteStops.length === 0) {
      elements.stopsList.innerHTML =
        '<li style="justify-content:center;color:var(--color-text-muted);font-style:italic;">No stops defined.</li>';
      return;
    }

    elements.stopsList.innerHTML = selectedRouteStops.map(function (stop, index) {
      return (
        '<li draggable="true" data-stop-id="' + stop.id + '" data-index="' + index + '">' +
          '<div class="reorder-btns">' +
            '<button class="btn-move-up" data-index="' + index + '" title="Move up">▲</button>' +
            '<button class="btn-move-down" data-index="' + index + '" title="Move down">▼</button>' +
          '</div>' +
          '<span class="stop-order-badge">' + stop.stop_order + '</span>' +
          '<div class="stop-info">' +
            '<div class="stop-name">' + escapeHtml(stop.stop_name) + '</div>' +
            '<div class="stop-coords">' +
              stop.latitude.toFixed(6) + ', ' + stop.longitude.toFixed(6) +
              ' · Radius: ' + stop.geofence_radius_meters + 'm' +
            '</div>' +
          '</div>' +
          '<div class="stop-actions">' +
            '<button class="btn btn-sm btn-secondary btn-edit-stop" data-stop-id="' + stop.id + '">Edit</button>' +
            '<button class="btn btn-sm btn-danger btn-delete-stop" data-stop-id="' + stop.id + '">✕</button>' +
          '</div>' +
        '</li>'
      );
    }).join('');

    bindStopEvents();
  }

  function bindStopEvents() {
    // Edit stop buttons
    elements.stopsList.querySelectorAll('.btn-edit-stop').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var stopId = this.getAttribute('data-stop-id');
        openEditStopForm(stopId);
      });
    });

    // Delete stop buttons
    elements.stopsList.querySelectorAll('.btn-delete-stop').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var stopId = this.getAttribute('data-stop-id');
        openDeleteConfirm('stop', stopId, 'Are you sure you want to remove this stop?');
      });
    });

    // Move up/down buttons
    elements.stopsList.querySelectorAll('.btn-move-up').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-index'));
        if (idx > 0) reorderStops(idx, idx - 1);
      });
    });

    elements.stopsList.querySelectorAll('.btn-move-down').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-index'));
        if (idx < selectedRouteStops.length - 1) reorderStops(idx, idx + 1);
      });
    });

    // Drag and drop
    var items = elements.stopsList.querySelectorAll('li[draggable]');
    items.forEach(function (item) {
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('dragenter', handleDragEnter);
      item.addEventListener('dragleave', handleDragLeave);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragend', handleDragEnd);
    });
  }

  var dragSrcIndex = null;

  function handleDragStart(e) {
    dragSrcIndex = parseInt(this.getAttribute('data-index'));
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcIndex.toString());
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function handleDragEnter(e) {
    e.preventDefault();
    this.style.borderTop = '2px solid var(--color-primary)';
  }

  function handleDragLeave() {
    this.style.borderTop = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    this.style.borderTop = '';
    var targetIndex = parseInt(this.getAttribute('data-index'));
    if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
      reorderStops(dragSrcIndex, targetIndex);
    }
  }

  function handleDragEnd() {
    this.classList.remove('dragging');
    dragSrcIndex = null;
  }

  async function reorderStops(fromIndex, toIndex) {
    // Swap in local array
    var item = selectedRouteStops.splice(fromIndex, 1)[0];
    selectedRouteStops.splice(toIndex, 0, item);

    // Update stop_order values
    selectedRouteStops.forEach(function (stop, i) {
      stop.stop_order = i + 1;
    });

    renderStopsList();
    updateMap();

    // Persist reorder via Edge Function
    var stopOrders = selectedRouteStops.map(function (s) {
      return { stop_id: s.id, stop_order: s.stop_order };
    });

    await callManageRoutes({
      action: 'reorder_stops',
      route_id: selectedRoute.id,
      stop_orders: stopOrders,
    });
  }

  // ---------------------------------------------------------------------------
  // Interactive Map (Leaflet)
  // ---------------------------------------------------------------------------

  function initMap() {
    if (map) {
      map.remove();
      map = null;
    }

    var mapEl = document.getElementById('route-map');
    if (!mapEl) return;

    // Default center: South Africa
    var defaultCenter = [-29.0, 26.0];
    var defaultZoom = 6;

    map = L.map('route-map').setView(defaultCenter, defaultZoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    // Allow click to pick coordinates when stop modal is open
    map.on('click', function (e) {
      if (pickingCoords) {
        document.getElementById('form-stop-lat').value = e.latlng.lat.toFixed(6);
        document.getElementById('form-stop-lng').value = e.latlng.lng.toFixed(6);
      }
    });

    updateMap();
  }

  function updateMap() {
    if (!map) return;

    // Clear existing markers and polyline
    mapMarkers.forEach(function (m) { map.removeLayer(m); });
    mapMarkers = [];
    if (mapPolyline) {
      map.removeLayer(mapPolyline);
      mapPolyline = null;
    }

    if (!selectedRouteStops || selectedRouteStops.length === 0) return;

    var latlngs = [];

    selectedRouteStops.forEach(function (stop, index) {
      var latlng = [stop.latitude, stop.longitude];
      latlngs.push(latlng);

      var marker = L.marker(latlng).addTo(map);
      marker.bindPopup(
        '<strong>' + escapeHtml(stop.stop_name) + '</strong><br/>' +
        'Stop #' + stop.stop_order + '<br/>' +
        'Geofence: ' + stop.geofence_radius_meters + 'm'
      );

      // Number the marker
      marker.bindTooltip(String(stop.stop_order), {
        permanent: true,
        direction: 'center',
        className: 'stop-marker-label',
      });

      mapMarkers.push(marker);
    });

    // Draw polyline connecting stops in order
    if (latlngs.length > 1) {
      mapPolyline = L.polyline(latlngs, {
        color: '#8B1A2B',
        weight: 3,
        opacity: 0.7,
        dashArray: '8, 4',
      }).addTo(map);
    }

    // Fit map bounds
    if (latlngs.length > 0) {
      var bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  // ---------------------------------------------------------------------------
  // Route Form (Create / Edit)
  // ---------------------------------------------------------------------------

  function openNewRouteForm() {
    editingRouteId = null;
    elements.routeModalTitle.textContent = 'New Route';
    elements.routeForm.reset();
    document.getElementById('form-is-active').value = 'true';
    hideError(elements.routeFormError);
    openModal(elements.routeModal);
  }

  function openEditRouteForm() {
    if (!selectedRoute) return;
    editingRouteId = selectedRoute.id;
    elements.routeModalTitle.textContent = 'Edit Route';

    document.getElementById('form-route-name').value = selectedRoute.route_name || '';
    document.getElementById('form-school-name').value = selectedRoute.school_name || '';
    document.getElementById('form-travel-minutes').value = selectedRoute.estimated_travel_minutes || '';
    document.getElementById('form-monthly-fee').value = selectedRoute.monthly_fee || '';
    document.getElementById('form-is-active').value = selectedRoute.is_active ? 'true' : 'false';

    hideError(elements.routeFormError);
    openModal(elements.routeModal);
  }

  async function handleSaveRoute() {
    hideError(elements.routeFormError);

    var routeName = document.getElementById('form-route-name').value.trim();
    var schoolName = document.getElementById('form-school-name').value.trim();
    var travelMinutes = parseInt(document.getElementById('form-travel-minutes').value);
    var monthlyFee = parseFloat(document.getElementById('form-monthly-fee').value);
    var isActive = document.getElementById('form-is-active').value === 'true';

    // Validation
    if (!routeName || !schoolName) {
      showError(elements.routeFormError, 'Route name and school name are required.');
      return;
    }
    if (!travelMinutes || travelMinutes < 1) {
      showError(elements.routeFormError, 'Estimated travel time must be at least 1 minute.');
      return;
    }
    if (isNaN(monthlyFee) || monthlyFee < 0) {
      showError(elements.routeFormError, 'Monthly fee must be a valid amount.');
      return;
    }

    var payload = {
      action: editingRouteId ? 'update_route' : 'create_route',
      route_name: routeName,
      school_name: schoolName,
      estimated_travel_minutes: travelMinutes,
      monthly_fee: monthlyFee,
      is_active: isActive,
    };
    if (editingRouteId) payload.route_id = editingRouteId;

    var result = await callManageRoutes(payload);

    if (result.success) {
      closeRouteModal();
      if (editingRouteId && selectedRoute) {
        // Refresh detail view
        selectedRoute = Object.assign({}, selectedRoute, {
          route_name: routeName,
          school_name: schoolName,
          estimated_travel_minutes: travelMinutes,
          monthly_fee: monthlyFee,
          is_active: isActive,
        });
        renderRouteDetail();
      } else {
        loadRoutes();
      }
    } else {
      // Fallback: try direct Supabase insert/update
      var directResult = await saveRouteDirect(payload);
      if (directResult.success) {
        closeRouteModal();
        if (editingRouteId) {
          selectedRoute = Object.assign({}, selectedRoute, {
            route_name: routeName, school_name: schoolName,
            estimated_travel_minutes: travelMinutes,
            monthly_fee: monthlyFee, is_active: isActive,
          });
          renderRouteDetail();
        } else {
          loadRoutes();
        }
      } else {
        showError(elements.routeFormError, directResult.error || 'Failed to save route.');
      }
    }
  }

  async function saveRouteDirect(payload) {
    try {
      var user = window.__phoenixServices.getCurrentUser();
      var tenantId = user ? user.tenantId : null;

      if (payload.action === 'create_route') {
        var body = {
          route_name: payload.route_name,
          school_name: payload.school_name,
          estimated_travel_minutes: payload.estimated_travel_minutes,
          monthly_fee: payload.monthly_fee,
          is_active: payload.is_active,
        };
        if (tenantId) body.tenant_id = tenantId;

        var response = await fetch(SUPABASE_URL + '/rest/v1/transport_routes', {
          method: 'POST',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(body),
        });
        if (response.ok) return { success: true, data: await response.json() };
        var errData = await response.json();
        return { success: false, error: errData.message || 'Insert failed' };
      } else {
        var updateBody = {
          route_name: payload.route_name,
          school_name: payload.school_name,
          estimated_travel_minutes: payload.estimated_travel_minutes,
          monthly_fee: payload.monthly_fee,
          is_active: payload.is_active,
        };
        var url = SUPABASE_URL + '/rest/v1/transport_routes?id=eq.' + payload.route_id;
        var resp = await fetch(url, {
          method: 'PATCH',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(updateBody),
        });
        if (resp.ok) return { success: true, data: await resp.json() };
        var errBody = await resp.json();
        return { success: false, error: errBody.message || 'Update failed' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Stop Form (Create / Edit)
  // ---------------------------------------------------------------------------

  function openNewStopForm() {
    editingStopId = null;
    elements.stopModalTitle.textContent = 'Add Stop';
    elements.stopForm.reset();
    document.getElementById('form-geofence-radius').value = '100';
    document.getElementById('form-stop-order').value = selectedRouteStops.length + 1;
    hideError(elements.stopFormError);
    pickingCoords = true;
    openModal(elements.stopModal);
  }

  function openEditStopForm(stopId) {
    var stop = selectedRouteStops.find(function (s) { return s.id === stopId; });
    if (!stop) return;
    editingStopId = stopId;
    elements.stopModalTitle.textContent = 'Edit Stop';

    document.getElementById('form-stop-name').value = stop.stop_name || '';
    document.getElementById('form-stop-lat').value = stop.latitude || '';
    document.getElementById('form-stop-lng').value = stop.longitude || '';
    document.getElementById('form-geofence-radius').value = stop.geofence_radius_meters || 100;
    document.getElementById('form-stop-order').value = stop.stop_order || '';

    hideError(elements.stopFormError);
    pickingCoords = true;
    openModal(elements.stopModal);
  }

  async function handleSaveStop() {
    hideError(elements.stopFormError);

    var stopName = document.getElementById('form-stop-name').value.trim();
    var lat = parseFloat(document.getElementById('form-stop-lat').value);
    var lng = parseFloat(document.getElementById('form-stop-lng').value);
    var radius = parseInt(document.getElementById('form-geofence-radius').value);
    var order = parseInt(document.getElementById('form-stop-order').value);

    // Validation
    if (!stopName) {
      showError(elements.stopFormError, 'Stop name is required.');
      return;
    }
    if (isNaN(lat) || lat < -90 || lat > 90) {
      showError(elements.stopFormError, 'Latitude must be between -90 and 90.');
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      showError(elements.stopFormError, 'Longitude must be between -180 and 180.');
      return;
    }
    if (isNaN(radius) || radius < 10 || radius > 5000) {
      showError(elements.stopFormError, 'Geofence radius must be between 10 and 5000 meters.');
      return;
    }

    var payload = {
      action: editingStopId ? 'update_stop' : 'create_stop',
      route_id: selectedRoute.id,
      stop_name: stopName,
      latitude: lat,
      longitude: lng,
      geofence_radius_meters: radius,
      stop_order: order || (selectedRouteStops.length + 1),
    };
    if (editingStopId) payload.stop_id = editingStopId;

    var result = await callManageRoutes(payload);

    if (result.success) {
      closeStopModal();
      await loadStops(selectedRoute.id);
      renderRouteDetail();
      updateMap();
    } else {
      // Fallback: try direct Supabase
      var directResult = await saveStopDirect(payload);
      if (directResult.success) {
        closeStopModal();
        await loadStops(selectedRoute.id);
        renderRouteDetail();
        updateMap();
      } else {
        showError(elements.stopFormError, directResult.error || 'Failed to save stop.');
      }
    }
  }

  async function saveStopDirect(payload) {
    try {
      var user = window.__phoenixServices.getCurrentUser();
      var tenantId = user ? user.tenantId : null;

      if (payload.action === 'create_stop') {
        var body = {
          route_id: payload.route_id,
          stop_name: payload.stop_name,
          latitude: payload.latitude,
          longitude: payload.longitude,
          geofence_radius_meters: payload.geofence_radius_meters,
          stop_order: payload.stop_order,
        };
        if (tenantId) body.tenant_id = tenantId;

        var response = await fetch(SUPABASE_URL + '/rest/v1/transport_stops', {
          method: 'POST',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(body),
        });
        if (response.ok) return { success: true, data: await response.json() };
        var errData = await response.json();
        return { success: false, error: errData.message || 'Insert failed' };
      } else {
        var updateBody = {
          stop_name: payload.stop_name,
          latitude: payload.latitude,
          longitude: payload.longitude,
          geofence_radius_meters: payload.geofence_radius_meters,
          stop_order: payload.stop_order,
        };
        var url = SUPABASE_URL + '/rest/v1/transport_stops?id=eq.' + payload.stop_id;
        var resp = await fetch(url, {
          method: 'PATCH',
          headers: Object.assign({}, getAuthHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(updateBody),
        });
        if (resp.ok) return { success: true, data: await resp.json() };
        var errBody = await resp.json();
        return { success: false, error: errBody.message || 'Update failed' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Operations
  // ---------------------------------------------------------------------------

  function openDeleteConfirm(type, id, message) {
    deleteTarget = { type: type, id: id };
    elements.deleteMessage.textContent = message;
    openModal(elements.deleteModal);
  }

  function closeDeleteModal() {
    deleteTarget = null;
    closeModal(elements.deleteModal);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;

    if (deleteTarget.type === 'route') {
      var result = await callManageRoutes({
        action: 'delete_route',
        route_id: deleteTarget.id,
      });
      if (result.success) {
        closeDeleteModal();
        showListView();
      } else {
        // Fallback direct delete
        var directResult = await deleteRouteDirect(deleteTarget.id);
        closeDeleteModal();
        if (directResult.success) showListView();
        else alert('Failed to delete route: ' + (directResult.error || 'Unknown error'));
      }
    } else if (deleteTarget.type === 'stop') {
      var stopResult = await callManageRoutes({
        action: 'delete_stop',
        route_id: selectedRoute.id,
        stop_id: deleteTarget.id,
      });
      if (stopResult.success) {
        closeDeleteModal();
        await loadStops(selectedRoute.id);
        renderRouteDetail();
        updateMap();
      } else {
        var directStopResult = await deleteStopDirect(deleteTarget.id);
        closeDeleteModal();
        if (directStopResult.success) {
          await loadStops(selectedRoute.id);
          renderRouteDetail();
          updateMap();
        } else {
          alert('Failed to delete stop: ' + (directStopResult.error || 'Unknown error'));
        }
      }
    }
  }

  async function deleteRouteDirect(routeId) {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_routes?id=eq.' + routeId;
      var resp = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
      return resp.ok ? { success: true } : { success: false, error: 'Delete failed' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function deleteStopDirect(stopId) {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_stops?id=eq.' + stopId;
      var resp = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
      return resp.ok ? { success: true } : { success: false, error: 'Delete failed' };
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

  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
  }

  function closeRouteModal() {
    closeModal(elements.routeModal);
    editingRouteId = null;
  }

  function closeStopModal() {
    closeModal(elements.stopModal);
    editingStopId = null;
    pickingCoords = false;
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
  // Utility Functions
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      var context = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(context, args);
      }, delay);
    };
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  // Wait for services to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
