/**
 * Google Places Autocomplete + Geocoding Service
 * Extracted from Horizen Logistics, adapted for Phoenix School Transport.
 *
 * Provides:
 * - Address autocomplete for stop forms
 * - Geocoding (address → lat/lng)
 * - Reverse geocoding (lat/lng → address)
 * - Route optimization between stops
 */
(function () {
  'use strict';

  var GOOGLE_MAPS_KEY = 'AIzaSyDn2_gaeG_2ug5WGM_13eM7vggU3v0mH_I';
  var loaded = false;
  var loadCallbacks = [];

  // ─── Load Google Maps JS API ────────────────────────────────────────────────

  function loadGoogleMaps(callback) {
    if (loaded && window.google && window.google.maps) {
      callback();
      return;
    }

    loadCallbacks.push(callback);

    // Check if script already loading
    if (document.querySelector('script[src*="maps.googleapis.com"]')) {
      return;
    }

    var script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=' + GOOGLE_MAPS_KEY + '&libraries=places,geometry';
    script.async = true;
    script.defer = true;
    script.onload = function () {
      loaded = true;
      loadCallbacks.forEach(function (cb) { cb(); });
      loadCallbacks = [];
    };
    script.onerror = function () {
      console.error('[google-places] Failed to load Google Maps API');
    };
    document.head.appendChild(script);
  }

  // ─── Address Autocomplete ───────────────────────────────────────────────────

  /**
   * Attach Google Places autocomplete to an input element.
   * When user selects an address, calls onSelect with { address, lat, lng }.
   *
   * @param {HTMLInputElement} inputElement - The text input to attach to
   * @param {Function} onSelect - Called with { address: string, lat: number, lng: number }
   * @param {Object} options - { country: 'za', types: ['address'] }
   * @returns {Object|null} The autocomplete instance (for cleanup)
   */
  function attachAutocomplete(inputElement, onSelect, options) {
    if (!inputElement) return null;

    var opts = options || {};
    var autocompleteInstance = null;

    loadGoogleMaps(function () {
      if (!window.google || !window.google.maps || !window.google.maps.places) {
        console.warn('[google-places] Places library not available');
        return;
      }

      autocompleteInstance = new google.maps.places.Autocomplete(inputElement, {
        types: opts.types || ['address'],
        componentRestrictions: { country: opts.country || 'za' },
        fields: ['formatted_address', 'geometry', 'name']
      });

      autocompleteInstance.addListener('place_changed', function () {
        var place = autocompleteInstance.getPlace();
        if (place && place.formatted_address && place.geometry && place.geometry.location) {
          var result = {
            address: place.formatted_address,
            name: place.name || '',
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng()
          };
          if (onSelect) onSelect(result);
        }
      });

      // Style the pac-container for dark/light mode compatibility
      var style = document.createElement('style');
      style.textContent = '.pac-container { z-index: 10000; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); border: 1px solid #E2E8F0; font-family: Inter, sans-serif; } .pac-item { padding: 8px 12px; font-size: 13px; } .pac-item:hover { background: #F8FAFF; }';
      document.head.appendChild(style);
    });

    return {
      getInstance: function () { return autocompleteInstance; },
      destroy: function () {
        if (autocompleteInstance) {
          google.maps.event.clearInstanceListeners(autocompleteInstance);
        }
      }
    };
  }

  // ─── Geocoding ──────────────────────────────────────────────────────────────

  /**
   * Convert an address string to lat/lng coordinates.
   * @param {string} address
   * @returns {Promise<{lat: number, lng: number, formatted_address: string}>}
   */
  function geocodeAddress(address) {
    return new Promise(function (resolve, reject) {
      loadGoogleMaps(function () {
        var geocoder = new google.maps.Geocoder();
        geocoder.geocode({ address: address }, function (results, status) {
          if (status === 'OK' && results && results.length > 0) {
            var location = results[0].geometry.location;
            resolve({
              lat: location.lat(),
              lng: location.lng(),
              formatted_address: results[0].formatted_address
            });
          } else {
            reject(new Error('Geocoding failed: ' + status));
          }
        });
      });
    });
  }

  /**
   * Convert lat/lng coordinates to an address string.
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<{address: string, formatted_address: string}>}
   */
  function reverseGeocode(lat, lng) {
    return new Promise(function (resolve, reject) {
      loadGoogleMaps(function () {
        var geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat: lat, lng: lng } }, function (results, status) {
          if (status === 'OK' && results && results.length > 0) {
            resolve({
              address: results[0].formatted_address,
              formatted_address: results[0].formatted_address
            });
          } else {
            reject(new Error('Reverse geocoding failed: ' + status));
          }
        });
      });
    });
  }

  // ─── Route Optimization ─────────────────────────────────────────────────────

  /**
   * Calculate optimal route between multiple stops using Google Directions API.
   * Returns driving directions with distance, duration, and optimized waypoint order.
   *
   * @param {Array<{lat: number, lng: number, name?: string}>} stops - Ordered stops
   * @param {boolean} optimize - Whether to optimize waypoint order (default: false)
   * @returns {Promise<{distance_km: number, duration_minutes: number, optimized_order: number[], legs: Array}>}
   */
  function calculateRoute(stops, optimize) {
    return new Promise(function (resolve, reject) {
      if (!stops || stops.length < 2) {
        reject(new Error('At least 2 stops required'));
        return;
      }

      loadGoogleMaps(function () {
        var directionsService = new google.maps.DirectionsService();

        var origin = stops[0];
        var destination = stops[stops.length - 1];
        var waypoints = stops.slice(1, -1).map(function (stop) {
          return { location: { lat: stop.lat, lng: stop.lng }, stopover: true };
        });

        directionsService.route({
          origin: { lat: origin.lat, lng: origin.lng },
          destination: { lat: destination.lat, lng: destination.lng },
          waypoints: waypoints,
          optimizeWaypoints: optimize || false,
          travelMode: google.maps.TravelMode.DRIVING
        }, function (result, status) {
          if (status === 'OK' && result && result.routes && result.routes.length > 0) {
            var route = result.routes[0];
            var totalDistance = 0;
            var totalDuration = 0;
            var legs = [];

            route.legs.forEach(function (leg) {
              totalDistance += leg.distance.value;
              totalDuration += leg.duration.value;
              legs.push({
                start_address: leg.start_address,
                end_address: leg.end_address,
                distance_km: (leg.distance.value / 1000).toFixed(1),
                duration_minutes: Math.round(leg.duration.value / 60)
              });
            });

            resolve({
              distance_km: (totalDistance / 1000).toFixed(1),
              duration_minutes: Math.round(totalDuration / 60),
              optimized_order: route.waypoint_order || [],
              legs: legs
            });
          } else {
            reject(new Error('Directions API failed: ' + status));
          }
        });
      });
    });
  }

  // ─── Expose globally ────────────────────────────────────────────────────────

  window.phoenixGooglePlaces = {
    loadGoogleMaps: loadGoogleMaps,
    attachAutocomplete: attachAutocomplete,
    geocodeAddress: geocodeAddress,
    reverseGeocode: reverseGeocode,
    calculateRoute: calculateRoute,
    apiKey: GOOGLE_MAPS_KEY,
  };

  console.log('[google-places] Service registered');
})();
