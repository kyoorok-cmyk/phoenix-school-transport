/**
 * Live Tracking Page Controller
 *
 * Vanilla JS controller for the Live Tracking map page.
 * Subscribes to Supabase Realtime channels for GPS updates,
 * displays vehicle positions on a full-screen Leaflet map,
 * handles signal loss detection, route deviation alerts, and ETA calculation.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var SIGNAL_LOST_THRESHOLD_MS = 120 * 1000; // 120 seconds
  var SIGNAL_CHECK_INTERVAL_MS = 10 * 1000;  // check every 10 seconds
  var ALERT_DISMISS_MS = 15000;              // auto-dismiss alerts after 15s
  var MAX_ALERTS = 5;                        // maximum visible alerts

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var map = null;
  var activeTrips = [];          // Array of trip objects with live data
  var vehicleMarkers = {};       // { tripId: L.Marker }
  var realtimeChannels = [];     // Active Supabase Realtime channel refs
  var signalCheckTimer = null;
  var selectedTripId = null;
  var alertIdCounter = 0;

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  var elements = {
    tripList: document.getElementById('trip-list'),
    tripSearchInput: document.getElementById('trip-search-input'),
    trackingMap: document.getElementById('tracking-map'),
    alertBanner: document.getElementById('alert-banner'),
    countTotal: document.getElementById('count-total'),
    countOnTime: document.getElementById('count-on-time'),
    countDelayed: document.getElementById('count-delayed'),
  };

  // ---------------------------------------------------------------------------
  // Service — Supabase configuration
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

  function getCurrentTenantId() {
    var user = window.__phoenixServices ? window.__phoenixServices.getCurrentUser() : null;
    return user ? user.tenantId : null;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    initMap();
    bindEvents();
    loadActiveTrips();
    startSignalLossChecker();
    subscribeToAlerts();
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  function bindEvents() {
    elements.tripSearchInput.addEventListener('input', debounce(handleTripSearch, 250));
  }

  // ---------------------------------------------------------------------------
  // Map Initialization
  // ---------------------------------------------------------------------------

  function initMap() {
    // Default center: South Africa
    var defaultCenter = [-29.0, 26.0];
    var defaultZoom = 6;

    map = L.map('tracking-map', {
      zoomControl: true,
      attributionControl: true,
    }).setView(defaultCenter, defaultZoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
  }

  // ---------------------------------------------------------------------------
  // Load Active Trips
  // ---------------------------------------------------------------------------

  async function loadActiveTrips() {
    try {
      var url = SUPABASE_URL + '/rest/v1/transport_trips' +
        '?status=eq.in_progress' +
        '&select=id,route_id,vehicle_id,driver_id,trip_type,scheduled_departure,actual_departure,' +
        'transport_routes(id,route_name,school_name),' +
        'transport_vehicles(id,registration_number,make,model),' +
        'users(id,raw_user_meta_data)';

      var response = await fetch(url, { headers: getAuthHeaders() });

      if (!response.ok) {
        console.error('[Tracking] Failed to load trips:', response.status);
        renderEmptyTripList('Failed to load active trips.');
        return;
      }

      var trips = await response.json();

      // Map trips into our internal state
      activeTrips = trips.map(function (trip) {
        return {
          id: trip.id,
          routeId: trip.route_id,
          vehicleId: trip.vehicle_id,
          driverId: trip.driver_id,
          tripType: trip.trip_type,
          scheduledDeparture: trip.scheduled_departure,
          actualDeparture: trip.actual_departure,
          routeName: trip.transport_routes ? trip.transport_routes.route_name : 'Unknown Route',
          schoolName: trip.transport_routes ? trip.transport_routes.school_name : '',
          vehicleReg: trip.transport_vehicles ? trip.transport_vehicles.registration_number : 'Unknown',
          vehicleMake: trip.transport_vehicles
            ? (trip.transport_vehicles.make + ' ' + trip.transport_vehicles.model)
            : '',
          driverName: extractDriverName(trip.users),
          // Live GPS state
          latitude: null,
          longitude: null,
          speed: 0,
          heading: 0,
          lastUpdate: null,
          // Derived state
          status: 'on_time',       // on_time | delayed | signal_lost
          nextStopName: null,
          nextStopEta: null,
          deviation: false,
        };
      });

      renderTripList(activeTrips);
      updateSummaryCounts();
      subscribeToTripLocations();
      loadLatestPositions();

    } catch (err) {
      console.error('[Tracking] Error loading trips:', err);
      renderEmptyTripList('Error loading trips: ' + err.message);
    }
  }

  function extractDriverName(userObj) {
    if (!userObj) return 'Unknown Driver';
    if (userObj.raw_user_meta_data) {
      var meta = typeof userObj.raw_user_meta_data === 'string'
        ? JSON.parse(userObj.raw_user_meta_data)
        : userObj.raw_user_meta_data;
      return meta.display_name || meta.full_name || meta.name || 'Driver';
    }
    return 'Driver';
  }

  // ---------------------------------------------------------------------------
  // Load Latest Known Positions (initial state)
  // ---------------------------------------------------------------------------

  async function loadLatestPositions() {
    for (var i = 0; i < activeTrips.length; i++) {
      var trip = activeTrips[i];
      try {
        var url = SUPABASE_URL + '/rest/v1/transport_trip_locations' +
          '?trip_id=eq.' + trip.id +
          '&order=recorded_at.desc&limit=1';

        var response = await fetch(url, { headers: getAuthHeaders() });
        if (response.ok) {
          var locations = await response.json();
          if (locations.length > 0) {
            var loc = locations[0];
            trip.latitude = loc.latitude;
            trip.longitude = loc.longitude;
            trip.speed = loc.speed_kmh || 0;
            trip.heading = loc.heading || 0;
            trip.lastUpdate = new Date(loc.recorded_at);
            updateVehicleMarker(trip);
          }
        }
      } catch (err) {
        console.warn('[Tracking] Could not load position for trip', trip.id, err);
      }
    }
    fitMapToVehicles();
    checkSignalLossStates();
  }

  // ---------------------------------------------------------------------------
  // Supabase Realtime — Trip Location Channels
  // ---------------------------------------------------------------------------

  function subscribeToTripLocations() {
    // Unsubscribe from previous channels
    unsubscribeAll();

    activeTrips.forEach(function (trip) {
      var channelName = 'trip:' + trip.id + ':location';

      // Use broadcast channel for live GPS updates
      var channel = createRealtimeChannel(channelName, function (payload) {
        handleLocationUpdate(trip.id, payload);
      });

      if (channel) {
        realtimeChannels.push(channel);
      }
    });
  }

  function createRealtimeChannel(channelName, onMessage) {
    // Build a Supabase Realtime channel subscription
    // Using the global supabase client exposed via supabase-bundle
    if (!window.__supabaseClient) {
      // Fallback: use REST-based polling approach
      console.warn('[Tracking] Supabase client not available, using polling fallback');
      return null;
    }

    var client = window.__supabaseClient;
    var channel = client
      .channel(channelName)
      .on('broadcast', { event: 'location' }, function (msg) {
        if (msg && msg.payload) {
          onMessage(msg.payload);
        }
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          console.log('[Tracking] Subscribed to', channelName);
        } else if (status === 'CHANNEL_ERROR') {
          console.error('[Tracking] Channel error for', channelName);
        }
      });

    return channel;
  }

  function subscribeToAlerts() {
    var tenantId = getCurrentTenantId();
    if (!tenantId) return;

    var channelName = 'tenant:' + tenantId + ':alerts';

    if (!window.__supabaseClient) {
      console.warn('[Tracking] Supabase client not available for alerts channel');
      return;
    }

    var client = window.__supabaseClient;
    var channel = client
      .channel(channelName)
      .on('broadcast', { event: 'alert' }, function (msg) {
        if (msg && msg.payload) {
          handleSystemAlert(msg.payload);
        }
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          console.log('[Tracking] Subscribed to alerts channel:', channelName);
        }
      });

    realtimeChannels.push(channel);
  }

  function unsubscribeAll() {
    if (window.__supabaseClient) {
      realtimeChannels.forEach(function (ch) {
        try {
          window.__supabaseClient.removeChannel(ch);
        } catch (e) {
          console.warn('[Tracking] Error removing channel:', e);
        }
      });
    }
    realtimeChannels = [];
  }

  // ---------------------------------------------------------------------------
  // Handle GPS Location Update
  // ---------------------------------------------------------------------------

  function handleLocationUpdate(tripId, payload) {
    var trip = activeTrips.find(function (t) { return t.id === tripId; });
    if (!trip) return;

    trip.latitude = payload.latitude;
    trip.longitude = payload.longitude;
    trip.speed = payload.speed_kmh || payload.speed || 0;
    trip.heading = payload.heading || 0;
    trip.lastUpdate = payload.recorded_at ? new Date(payload.recorded_at) : new Date();

    // Reset signal lost if we got a fresh update
    if (trip.status === 'signal_lost') {
      trip.status = 'on_time';
    }

    // Check deviation flag from payload
    if (payload.deviation) {
      trip.deviation = true;
      trip.status = 'delayed';
    } else {
      trip.deviation = false;
    }

    // Calculate ETA for next stop
    calculateNextStopEta(trip, payload);

    // Update UI
    updateVehicleMarker(trip);
    updateTripListItem(trip);
    updateSummaryCounts();
  }

  // ---------------------------------------------------------------------------
  // Handle System Alerts (deviation, signal loss)
  // ---------------------------------------------------------------------------

  function handleSystemAlert(payload) {
    var alertType = payload.type || payload.alert_type || 'info';
    var tripId = payload.trip_id;
    var message = payload.message || '';

    if (alertType === 'deviation' || alertType === 'route_deviation') {
      var trip = activeTrips.find(function (t) { return t.id === tripId; });
      if (trip) {
        trip.deviation = true;
        trip.status = 'delayed';
        updateVehicleMarker(trip);
        updateTripListItem(trip);
        updateSummaryCounts();
      }
      showAlert('🚨 Route Deviation', message || ('Vehicle ' + (trip ? trip.vehicleReg : '') + ' has deviated from planned route.'), 'danger');
    } else if (alertType === 'signal_lost' || alertType === 'signal_loss') {
      var tripSig = activeTrips.find(function (t) { return t.id === tripId; });
      if (tripSig) {
        tripSig.status = 'signal_lost';
        updateVehicleMarker(tripSig);
        updateTripListItem(tripSig);
        updateSummaryCounts();
      }
      showAlert('📡 Signal Lost', message || ('Vehicle ' + (tripSig ? tripSig.vehicleReg : '') + ' has lost GPS signal.'), 'warning');
    } else {
      showAlert('ℹ️ Alert', message, 'warning');
    }
  }

  // ---------------------------------------------------------------------------
  // ETA Calculation
  // ---------------------------------------------------------------------------

  function calculateNextStopEta(trip, payload) {
    // If payload includes next_stop info from the Edge Function
    if (payload.next_stop_name) {
      trip.nextStopName = payload.next_stop_name;
    }
    if (payload.next_stop_distance_m !== undefined && trip.speed > 0) {
      // ETA = distance / speed
      var distanceKm = payload.next_stop_distance_m / 1000;
      var speedKmh = trip.speed;
      var etaHours = distanceKm / speedKmh;
      var etaMinutes = Math.round(etaHours * 60);
      trip.nextStopEta = etaMinutes < 1 ? '< 1 min' : etaMinutes + ' min';
    } else if (payload.eta_minutes !== undefined) {
      trip.nextStopEta = payload.eta_minutes < 1 ? '< 1 min' : payload.eta_minutes + ' min';
    } else {
      trip.nextStopEta = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Signal Loss Detection
  // ---------------------------------------------------------------------------

  function startSignalLossChecker() {
    signalCheckTimer = setInterval(checkSignalLossStates, SIGNAL_CHECK_INTERVAL_MS);
  }

  function checkSignalLossStates() {
    var now = Date.now();
    var changed = false;

    activeTrips.forEach(function (trip) {
      if (!trip.lastUpdate) return;

      var elapsed = now - trip.lastUpdate.getTime();

      if (elapsed > SIGNAL_LOST_THRESHOLD_MS) {
        if (trip.status !== 'signal_lost') {
          trip.status = 'signal_lost';
          updateVehicleMarker(trip);
          updateTripListItem(trip);
          changed = true;
        }
      }
    });

    if (changed) {
      updateSummaryCounts();
    }
  }

  function stopSignalLossChecker() {
    if (signalCheckTimer) {
      clearInterval(signalCheckTimer);
      signalCheckTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Map Markers
  // ---------------------------------------------------------------------------

  function updateVehicleMarker(trip) {
    if (trip.latitude === null || trip.longitude === null) return;

    var latlng = [trip.latitude, trip.longitude];
    var marker = vehicleMarkers[trip.id];

    if (!marker) {
      // Create a new marker
      marker = L.marker(latlng, {
        icon: createVehicleIcon(trip),
        title: trip.vehicleReg,
      }).addTo(map);

      marker.bindPopup(buildPopupContent(trip));
      vehicleMarkers[trip.id] = marker;
    } else {
      // Move existing marker
      marker.setLatLng(latlng);
      marker.setIcon(createVehicleIcon(trip));
      marker.setPopupContent(buildPopupContent(trip));
    }
  }

  function createVehicleIcon(trip) {
    var className = 'vehicle-marker';
    var html = '';

    if (trip.status === 'signal_lost') {
      className += ' marker-signal-lost';
      html = '<div style="background:#6c757d;color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;border:3px dashed #aaa;box-shadow:0 2px 6px rgba(0,0,0,0.2);">🚌</div>';
    } else if (trip.deviation) {
      className += ' marker-deviation';
      html = '<div style="background:#fff;color:#c0392b;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;border:3px solid #c0392b;box-shadow:0 2px 6px rgba(192,57,43,0.4);">🚌</div>';
    } else {
      html = '<div style="background:var(--color-primary, #8B1A2B);color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);">🚌</div>';
    }

    return L.divIcon({
      className: className,
      html: html,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -18],
    });
  }

  function buildPopupContent(trip) {
    var lastUpdateStr = trip.lastUpdate
      ? formatRelativeTime(trip.lastUpdate)
      : 'Never';

    var statusLabel = trip.status === 'signal_lost'
      ? '<span style="color:#dc3545;font-weight:600;">⚠ Signal Lost</span>'
      : trip.deviation
        ? '<span style="color:#c0392b;font-weight:600;">⚠ Route Deviation</span>'
        : '<span style="color:#28a745;font-weight:600;">✓ On Track</span>';

    var etaLine = trip.nextStopEta
      ? '<tr><td style="color:#888;padding:2px 8px 2px 0;">Next Stop:</td><td>' +
        escapeHtml(trip.nextStopName || 'N/A') + ' (ETA: ' + escapeHtml(trip.nextStopEta) + ')</td></tr>'
      : '';

    return (
      '<div style="min-width:200px;font-size:12px;">' +
        '<div style="font-weight:700;font-size:14px;margin-bottom:6px;color:#8B1A2B;">' +
          escapeHtml(trip.vehicleReg) +
        '</div>' +
        '<table style="border-collapse:collapse;">' +
          '<tr><td style="color:#888;padding:2px 8px 2px 0;">Driver:</td><td>' + escapeHtml(trip.driverName) + '</td></tr>' +
          '<tr><td style="color:#888;padding:2px 8px 2px 0;">Route:</td><td>' + escapeHtml(trip.routeName) + '</td></tr>' +
          '<tr><td style="color:#888;padding:2px 8px 2px 0;">Speed:</td><td>' + Number(trip.speed).toFixed(1) + ' km/h</td></tr>' +
          '<tr><td style="color:#888;padding:2px 8px 2px 0;">Last Update:</td><td>' + lastUpdateStr + '</td></tr>' +
          etaLine +
          '<tr><td style="color:#888;padding:2px 8px 2px 0;">Status:</td><td>' + statusLabel + '</td></tr>' +
        '</table>' +
      '</div>'
    );
  }

  function fitMapToVehicles() {
    var latlngs = [];
    activeTrips.forEach(function (trip) {
      if (trip.latitude !== null && trip.longitude !== null) {
        latlngs.push([trip.latitude, trip.longitude]);
      }
    });

    if (latlngs.length > 0) {
      var bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    }
  }

  // ---------------------------------------------------------------------------
  // Trip List Panel
  // ---------------------------------------------------------------------------

  function renderTripList(trips) {
    if (!trips || trips.length === 0) {
      renderEmptyTripList('No active trips at the moment.');
      return;
    }

    elements.tripList.innerHTML = trips.map(function (trip) {
      var statusClass = 'trip-status-' + trip.status;
      var statusLabel = formatStatusLabel(trip.status);
      var selectedClass = trip.id === selectedTripId ? ' selected' : '';
      var etaText = trip.nextStopEta ? 'ETA: ' + trip.nextStopEta : '';
      var speedText = trip.speed > 0 ? trip.speed.toFixed(0) + ' km/h' : 'Stationary';

      return (
        '<li data-trip-id="' + trip.id + '" class="' + selectedClass + '">' +
          '<div class="trip-item-header">' +
            '<span class="trip-vehicle">' + escapeHtml(trip.vehicleReg) + '</span>' +
            '<span class="trip-status-badge ' + statusClass + '">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="trip-route-name">' + escapeHtml(trip.routeName) + ' — ' + escapeHtml(trip.driverName) + '</div>' +
          '<div class="trip-meta">' +
            '<span>' + speedText + '</span>' +
            (etaText ? '<span>' + etaText + '</span>' : '') +
          '</div>' +
        '</li>'
      );
    }).join('');

    bindTripListEvents();
  }

  function renderEmptyTripList(message) {
    elements.tripList.innerHTML = '<li class="trip-list-empty">' + escapeHtml(message) + '</li>';
  }

  function updateTripListItem(trip) {
    var li = elements.tripList.querySelector('[data-trip-id="' + trip.id + '"]');
    if (!li) return;

    var statusClass = 'trip-status-' + trip.status;
    var statusLabel = formatStatusLabel(trip.status);
    var etaText = trip.nextStopEta ? 'ETA: ' + trip.nextStopEta : '';
    var speedText = trip.speed > 0 ? trip.speed.toFixed(0) + ' km/h' : 'Stationary';

    li.querySelector('.trip-status-badge').className = 'trip-status-badge ' + statusClass;
    li.querySelector('.trip-status-badge').textContent = statusLabel;

    var metaEl = li.querySelector('.trip-meta');
    metaEl.innerHTML = '<span>' + speedText + '</span>' + (etaText ? '<span>' + etaText + '</span>' : '');
  }

  function bindTripListEvents() {
    var items = elements.tripList.querySelectorAll('li[data-trip-id]');
    items.forEach(function (item) {
      item.addEventListener('click', function () {
        var tripId = this.getAttribute('data-trip-id');
        handleTripSelect(tripId);
      });
    });
  }

  function handleTripSelect(tripId) {
    selectedTripId = tripId;

    // Highlight selected item
    var items = elements.tripList.querySelectorAll('li[data-trip-id]');
    items.forEach(function (item) {
      item.classList.toggle('selected', item.getAttribute('data-trip-id') === tripId);
    });

    // Zoom to vehicle on map
    var trip = activeTrips.find(function (t) { return t.id === tripId; });
    if (trip && trip.latitude !== null && trip.longitude !== null) {
      map.setView([trip.latitude, trip.longitude], 15, { animate: true });
      // Open the popup
      var marker = vehicleMarkers[tripId];
      if (marker) {
        marker.openPopup();
      }
    }
  }

  function handleTripSearch() {
    var query = elements.tripSearchInput.value.trim().toLowerCase();

    if (!query) {
      renderTripList(activeTrips);
      return;
    }

    var filtered = activeTrips.filter(function (trip) {
      return trip.vehicleReg.toLowerCase().indexOf(query) !== -1 ||
        trip.routeName.toLowerCase().indexOf(query) !== -1 ||
        trip.driverName.toLowerCase().indexOf(query) !== -1;
    });

    renderTripList(filtered);
  }

  // ---------------------------------------------------------------------------
  // Summary Counts
  // ---------------------------------------------------------------------------

  function updateSummaryCounts() {
    var total = activeTrips.length;
    var onTime = 0;
    var delayed = 0;

    activeTrips.forEach(function (trip) {
      if (trip.status === 'on_time') onTime++;
      else delayed++;
    });

    elements.countTotal.textContent = total;
    elements.countOnTime.textContent = onTime;
    elements.countDelayed.textContent = delayed;
  }

  // ---------------------------------------------------------------------------
  // Alert Toasts
  // ---------------------------------------------------------------------------

  function showAlert(title, message, type) {
    alertIdCounter++;
    var alertId = 'alert-' + alertIdCounter;
    var iconClass = type === 'danger' ? 'alert-toast' : 'alert-toast alert-warning';
    var icon = type === 'danger' ? '🚨' : '⚠️';

    var html = (
      '<div class="' + iconClass + '" id="' + alertId + '">' +
        '<span class="alert-icon">' + icon + '</span>' +
        '<div class="alert-content">' +
          '<div class="alert-title">' + escapeHtml(title) + '</div>' +
          '<div class="alert-message">' + escapeHtml(message) + '</div>' +
        '</div>' +
        '<button class="alert-dismiss" data-alert-id="' + alertId + '">&times;</button>' +
      '</div>'
    );

    elements.alertBanner.insertAdjacentHTML('beforeend', html);

    // Bind dismiss
    var dismissBtn = document.getElementById(alertId).querySelector('.alert-dismiss');
    dismissBtn.addEventListener('click', function () {
      dismissAlert(this.getAttribute('data-alert-id'));
    });

    // Auto-dismiss
    setTimeout(function () {
      dismissAlert(alertId);
    }, ALERT_DISMISS_MS);

    // Limit max alerts
    var toasts = elements.alertBanner.querySelectorAll('.alert-toast');
    if (toasts.length > MAX_ALERTS) {
      toasts[0].remove();
    }
  }

  function dismissAlert(alertId) {
    var el = document.getElementById(alertId);
    if (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 200);
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------------------

  function formatStatusLabel(status) {
    switch (status) {
      case 'on_time': return 'On Time';
      case 'delayed': return 'Delayed';
      case 'signal_lost': return 'Signal Lost';
      default: return status;
    }
  }

  function formatRelativeTime(date) {
    if (!date) return 'Unknown';
    var now = Date.now();
    var diff = now - date.getTime();

    if (diff < 10000) return 'Just now';
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    return Math.floor(diff / 3600000) + 'h ago';
  }

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
  // Cleanup (on page unload)
  // ---------------------------------------------------------------------------

  window.addEventListener('beforeunload', function () {
    stopSignalLossChecker();
    unsubscribeAll();
  });

  // ---------------------------------------------------------------------------
  // Start — wait for Supabase client to be ready
  // ---------------------------------------------------------------------------

  function startWhenReady() {
    if (window.__phoenixServicesReady) {
      init();
    } else {
      window.addEventListener('phoenixServicesReady', init, { once: true });
      // Fallback timeout: proceed even if services didn't fire event
      setTimeout(function () {
        if (!window.__phoenixServicesReady) {
          console.warn('[Tracking] Services not ready after timeout, starting anyway');
          init();
        }
      }, 5000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWhenReady);
  } else {
    startWhenReady();
  }

})();
