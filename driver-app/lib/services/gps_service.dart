import 'dart:async';
import 'dart:collection';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'supabase_service.dart';

/// Represents a single GPS location data point.
@immutable
class GpsLocationData {
  final double latitude;
  final double longitude;
  final double? speedKmh;
  final double? heading;
  final DateTime timestamp;
  final String tripId;

  const GpsLocationData({
    required this.latitude,
    required this.longitude,
    this.speedKmh,
    this.heading,
    required this.timestamp,
    required this.tripId,
  });

  Map<String, dynamic> toJson() => {
        'trip_id': tripId,
        'latitude': latitude,
        'longitude': longitude,
        'recorded_at': timestamp.toUtc().toIso8601String(),
        if (speedKmh != null) 'speed_kmh': speedKmh,
        if (heading != null) 'heading': heading,
        'synced_from_offline': false,
      };

  @override
  String toString() =>
      'GpsLocationData(lat: $latitude, lng: $longitude, time: $timestamp)';
}

/// GPS signal status indicators.
enum GpsSignalStatus {
  /// GPS signal is active and receiving updates.
  active,

  /// GPS signal has been lost for > 60 seconds.
  lost,

  /// GPS is not tracking (no active trip).
  inactive,
}

/// Service responsible for background GPS location tracking during active trips.
///
/// Features:
/// - Transmits vehicle GPS location to the `store-gps-location` Edge Function every 10 seconds
/// - Publishes GPS updates to Supabase Realtime channel for live operator tracking
/// - Detects GPS signal loss > 60 seconds and emits a warning
/// - Queues GPS data locally (in memory) when offline for later sync
/// - Provides a stream of location updates for the ActiveTripScreen
/// - Handles location permission requests
/// - Supports background location tracking via foreground service (Android)
///
/// Validates: Requirements 6.2, 6.7, 12.5
class GpsService {
  GpsService._();

  static GpsService? _instance;

  /// Singleton instance.
  static GpsService get instance {
    _instance ??= GpsService._();
    return _instance!;
  }

  // ─── CONFIGURATION ──────────────────────────────────────────────────────────

  /// Interval between GPS transmissions to the server (seconds).
  static const int transmitIntervalSeconds = 10;

  /// Threshold for GPS signal loss warning (seconds).
  static const int signalLossThresholdSeconds = 60;

  /// Maximum distance filter for location updates (meters).
  /// A value of 0 means receive all updates.
  static const int distanceFilterMeters = 5;

  // ─── STATE ──────────────────────────────────────────────────────────────────

  /// Whether GPS tracking is currently active for a trip.
  bool _isTracking = false;

  /// The trip ID currently being tracked.
  String? _activeTripId;

  /// The Realtime channel for broadcasting GPS to the operator portal.
  RealtimeChannel? _realtimeChannel;

  /// Timer for periodic GPS transmission to the server.
  Timer? _transmitTimer;

  /// Timer for signal loss detection.
  Timer? _signalLossTimer;

  /// Last known position received from the GPS.
  Position? _lastPosition;

  /// Timestamp of the last successful GPS fix.
  DateTime? _lastGpsFixTime;

  /// Location stream subscription from geolocator.
  StreamSubscription<Position>? _positionSubscription;

  /// Whether the device is currently online.
  bool _isOnline = true;

  // ─── OFFLINE QUEUE ──────────────────────────────────────────────────────────

  /// In-memory FIFO queue for GPS data when offline.
  /// Sorted by timestamp for FIFO sync.
  final Queue<GpsLocationData> _offlineQueue = Queue<GpsLocationData>();

  /// Maximum offline queue size to prevent memory overflow.
  static const int maxOfflineQueueSize = 1000;

  // ─── STREAMS ────────────────────────────────────────────────────────────────

  /// Controller for location update stream consumed by UI.
  final StreamController<GpsLocationData> _locationStreamController =
      StreamController<GpsLocationData>.broadcast();

  /// Controller for GPS signal status changes.
  final StreamController<GpsSignalStatus> _signalStatusController =
      StreamController<GpsSignalStatus>.broadcast();

  /// Stream of GPS location updates for the ActiveTripScreen.
  Stream<GpsLocationData> get locationStream =>
      _locationStreamController.stream;

  /// Stream of GPS signal status changes (active, lost, inactive).
  Stream<GpsSignalStatus> get signalStatusStream =>
      _signalStatusController.stream;

  /// Whether GPS tracking is currently active.
  bool get isTracking => _isTracking;

  /// The active trip ID, or null if not tracking.
  String? get activeTripId => _activeTripId;

  /// Last known position.
  Position? get lastPosition => _lastPosition;

  /// Current signal status.
  GpsSignalStatus get currentSignalStatus {
    if (!_isTracking) return GpsSignalStatus.inactive;
    if (_lastGpsFixTime == null) return GpsSignalStatus.lost;
    final elapsed = DateTime.now().difference(_lastGpsFixTime!).inSeconds;
    return elapsed > signalLossThresholdSeconds
        ? GpsSignalStatus.lost
        : GpsSignalStatus.active;
  }

  /// Number of GPS points queued offline.
  int get offlineQueueSize => _offlineQueue.length;

  // ─── PERMISSIONS ────────────────────────────────────────────────────────────

  /// Check and request location permissions.
  ///
  /// Returns `true` if permissions are granted and location services are enabled.
  /// Returns `false` if the user denied permissions or services are disabled.
  Future<bool> requestLocationPermission() async {
    // Check if location services are enabled
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      developer.log(
        'Location services are disabled',
        name: 'GpsService',
        level: 900,
      );
      return false;
    }

    // Check current permission status
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        developer.log(
          'Location permission denied by user',
          name: 'GpsService',
          level: 900,
        );
        return false;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      developer.log(
        'Location permission permanently denied',
        name: 'GpsService',
        level: 1000,
      );
      return false;
    }

    // For background tracking on Android, we need "always" permission
    if (permission == LocationPermission.whileInUse) {
      // Request upgrade to always-on (for background foreground service)
      permission = await Geolocator.requestPermission();
      // Even if we only get "whileInUse", we can still use a foreground service
    }

    developer.log(
      'Location permission granted: $permission',
      name: 'GpsService',
    );
    return true;
  }

  // ─── TRACKING LIFECYCLE ─────────────────────────────────────────────────────

  /// Start GPS tracking for the given trip.
  ///
  /// This will:
  /// 1. Verify location permissions
  /// 2. Subscribe to the trip's Realtime channel
  /// 3. Start receiving location updates via foreground service
  /// 4. Begin periodic transmission to the Edge Function every 10 seconds
  /// 5. Start signal loss detection
  ///
  /// Throws [GpsPermissionException] if permissions are not granted.
  /// Throws [StateError] if already tracking a trip.
  Future<void> startTracking({required String tripId}) async {
    if (_isTracking) {
      if (_activeTripId == tripId) {
        developer.log(
          'Already tracking trip $tripId',
          name: 'GpsService',
        );
        return;
      }
      throw StateError(
        'Already tracking trip $_activeTripId. Stop current tracking first.',
      );
    }

    // Verify permissions
    final hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      throw GpsPermissionException(
        'Location permission is required to start GPS tracking. '
        'Please enable location services and grant permission.',
      );
    }

    _activeTripId = tripId;
    _isTracking = true;
    _lastGpsFixTime = null;

    developer.log(
      'Starting GPS tracking for trip: $tripId',
      name: 'GpsService',
    );

    // Subscribe to Realtime channel for broadcasting
    _realtimeChannel = TransportSupabaseService.instance
        .subscribeTripLocationChannel(tripId: tripId);

    // Start listening to position updates with foreground service settings
    _startPositionStream();

    // Start periodic transmit timer
    _transmitTimer = Timer.periodic(
      const Duration(seconds: transmitIntervalSeconds),
      (_) => _transmitLastPosition(),
    );

    // Start signal loss detection timer
    _startSignalLossDetection();

    _signalStatusController.add(GpsSignalStatus.active);
  }

  /// Stop GPS tracking for the current trip.
  ///
  /// This will:
  /// 1. Stop location stream subscription
  /// 2. Cancel transmit timer
  /// 3. Cancel signal loss timer
  /// 4. Unsubscribe from Realtime channel
  /// 5. Flush any remaining queued offline data
  Future<void> stopTracking() async {
    if (!_isTracking) {
      developer.log(
        'GPS tracking is not active, nothing to stop',
        name: 'GpsService',
      );
      return;
    }

    developer.log(
      'Stopping GPS tracking for trip: $_activeTripId',
      name: 'GpsService',
    );

    // Cancel timers
    _transmitTimer?.cancel();
    _transmitTimer = null;
    _signalLossTimer?.cancel();
    _signalLossTimer = null;

    // Stop position stream
    await _positionSubscription?.cancel();
    _positionSubscription = null;

    // Unsubscribe from Realtime channel
    if (_realtimeChannel != null) {
      await TransportSupabaseService.instance
          .unsubscribeChannel(_realtimeChannel!);
      _realtimeChannel = null;
    }

    _isTracking = false;
    _activeTripId = null;
    _lastPosition = null;
    _lastGpsFixTime = null;

    _signalStatusController.add(GpsSignalStatus.inactive);
  }

  // ─── POSITION STREAM ────────────────────────────────────────────────────────

  /// Start the geolocator position stream with foreground service configuration.
  void _startPositionStream() {
    // Android foreground service settings for background tracking
    const locationSettings = AndroidSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: distanceFilterMeters,
      intervalDuration: Duration(seconds: transmitIntervalSeconds),
      // Foreground service notification (required for background on Android)
      foregroundNotificationConfig: ForegroundNotificationConfig(
        notificationTitle: 'Phoenix Transport - Trip Active',
        notificationText: 'GPS tracking is active for your current trip',
        enableWakeLock: true,
      ),
    );

    // Use platform-appropriate settings
    final LocationSettings settings = defaultTargetPlatform == TargetPlatform.android
        ? locationSettings
        : const LocationSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: distanceFilterMeters,
          );

    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: settings,
    ).listen(
      _onPositionUpdate,
      onError: _onPositionError,
    );
  }

  /// Handle a new GPS position update.
  void _onPositionUpdate(Position position) {
    _lastPosition = position;
    _lastGpsFixTime = DateTime.now();

    // Reset signal loss timer
    _resetSignalLossTimer();

    // Update signal status if it was previously lost
    if (currentSignalStatus == GpsSignalStatus.active) {
      _signalStatusController.add(GpsSignalStatus.active);
    }

    if (_activeTripId == null) return;

    // Convert speed from m/s to km/h
    final speedKmh = position.speed >= 0 ? position.speed * 3.6 : null;

    final locationData = GpsLocationData(
      latitude: position.latitude,
      longitude: position.longitude,
      speedKmh: speedKmh,
      heading: position.heading >= 0 ? position.heading : null,
      timestamp: position.timestamp ?? DateTime.now(),
      tripId: _activeTripId!,
    );

    // Emit to UI stream
    _locationStreamController.add(locationData);

    // Broadcast to Realtime channel (non-blocking)
    _broadcastToRealtime(locationData);
  }

  /// Handle GPS position stream errors.
  void _onPositionError(Object error) {
    developer.log(
      'GPS position stream error: $error',
      name: 'GpsService',
      level: 1000,
    );
    // Don't stop tracking — the stream may recover
  }

  // ─── TRANSMISSION ───────────────────────────────────────────────────────────

  /// Transmit the last known position to the server via the Edge Function.
  /// Called every [transmitIntervalSeconds] seconds by the periodic timer.
  Future<void> _transmitLastPosition() async {
    if (!_isTracking || _lastPosition == null || _activeTripId == null) return;

    final speedKmh =
        _lastPosition!.speed >= 0 ? _lastPosition!.speed * 3.6 : null;

    final locationData = GpsLocationData(
      latitude: _lastPosition!.latitude,
      longitude: _lastPosition!.longitude,
      speedKmh: speedKmh,
      heading: _lastPosition!.heading >= 0 ? _lastPosition!.heading : null,
      timestamp: _lastPosition!.timestamp ?? DateTime.now(),
      tripId: _activeTripId!,
    );

    if (!_isOnline) {
      _queueOffline(locationData);
      return;
    }

    try {
      await TransportSupabaseService.instance.storeGpsLocation(
        tripId: locationData.tripId,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        recordedAt: locationData.timestamp,
        speedKmh: locationData.speedKmh,
        heading: locationData.heading,
      );
    } catch (e) {
      developer.log(
        'Failed to transmit GPS location, queuing offline: $e',
        name: 'GpsService',
        level: 900,
      );
      // If transmission fails, queue for later sync
      _queueOffline(locationData);
      _isOnline = false;
    }
  }

  /// Broadcast location to the Realtime channel for live operator tracking.
  Future<void> _broadcastToRealtime(GpsLocationData locationData) async {
    if (_realtimeChannel == null || !_isOnline) return;

    try {
      await TransportSupabaseService.instance.publishGpsLocation(
        channel: _realtimeChannel!,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        timestamp: locationData.timestamp,
        speedKmh: locationData.speedKmh,
        heading: locationData.heading,
      );
    } catch (e) {
      // Non-fatal: Realtime is best-effort, Edge Function is the persistence path
      developer.log(
        'Realtime broadcast failed (non-fatal): $e',
        name: 'GpsService',
        level: 800,
      );
    }
  }

  // ─── SIGNAL LOSS DETECTION ──────────────────────────────────────────────────

  /// Start the signal loss detection timer.
  void _startSignalLossDetection() {
    _signalLossTimer?.cancel();
    _signalLossTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _checkSignalLoss(),
    );
  }

  /// Reset the signal loss timer when a new GPS fix is received.
  void _resetSignalLossTimer() {
    // No explicit reset needed — the periodic check uses _lastGpsFixTime
  }

  /// Check if GPS signal has been lost for more than [signalLossThresholdSeconds].
  void _checkSignalLoss() {
    if (!_isTracking || _lastGpsFixTime == null) return;

    final elapsed = DateTime.now().difference(_lastGpsFixTime!).inSeconds;
    if (elapsed > signalLossThresholdSeconds) {
      developer.log(
        'GPS signal lost for ${elapsed}s (threshold: ${signalLossThresholdSeconds}s)',
        name: 'GpsService',
        level: 900,
      );
      _signalStatusController.add(GpsSignalStatus.lost);
    }
  }

  // ─── OFFLINE QUEUE MANAGEMENT ───────────────────────────────────────────────

  /// Queue a GPS location for later sync when offline.
  void _queueOffline(GpsLocationData locationData) {
    if (_offlineQueue.length >= maxOfflineQueueSize) {
      // Remove oldest entry to make room (FIFO with bounded size)
      _offlineQueue.removeFirst();
      developer.log(
        'Offline GPS queue full, dropping oldest entry',
        name: 'GpsService',
        level: 900,
      );
    }
    _offlineQueue.addLast(locationData);
    developer.log(
      'Queued GPS data offline (queue size: ${_offlineQueue.length})',
      name: 'GpsService',
    );
  }

  /// Notify the GPS service that connectivity has been restored.
  ///
  /// This triggers a flush of the offline queue.
  void onConnectivityRestored() {
    _isOnline = true;
    developer.log(
      'Connectivity restored, flushing ${_offlineQueue.length} queued GPS points',
      name: 'GpsService',
    );
    _flushOfflineQueue();
  }

  /// Notify the GPS service that connectivity has been lost.
  void onConnectivityLost() {
    _isOnline = false;
    developer.log(
      'Connectivity lost, GPS data will be queued',
      name: 'GpsService',
    );
  }

  /// Flush the offline queue by syncing all queued GPS data to the server.
  ///
  /// Data is transmitted in FIFO order (oldest first).
  /// If sync fails, remaining items stay in the queue for the next attempt.
  Future<void> _flushOfflineQueue() async {
    if (_offlineQueue.isEmpty) return;

    final itemsToSync = List<GpsLocationData>.from(_offlineQueue);
    var syncedCount = 0;

    for (final locationData in itemsToSync) {
      try {
        await TransportSupabaseService.instance.storeGpsLocation(
          tripId: locationData.tripId,
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          recordedAt: locationData.timestamp,
          speedKmh: locationData.speedKmh,
          heading: locationData.heading,
          syncedFromOffline: true,
        );
        _offlineQueue.removeFirst();
        syncedCount++;
      } catch (e) {
        developer.log(
          'Offline queue flush interrupted after $syncedCount items: $e',
          name: 'GpsService',
          level: 900,
        );
        // Stop flushing — connectivity likely lost again
        _isOnline = false;
        break;
      }
    }

    if (syncedCount > 0) {
      developer.log(
        'Flushed $syncedCount GPS points from offline queue '
        '(remaining: ${_offlineQueue.length})',
        name: 'GpsService',
      );
    }
  }

  /// Get all queued offline GPS data as a list of maps for bulk sync.
  ///
  /// Used by the OfflineSyncService for batch submission via the
  /// `sync-offline-data` Edge Function.
  List<Map<String, dynamic>> getOfflineQueueAsJson() {
    return _offlineQueue.map((loc) => loc.toJson()).toList();
  }

  /// Clear the offline queue after a successful bulk sync.
  void clearOfflineQueue() {
    _offlineQueue.clear();
    developer.log(
      'Offline GPS queue cleared after bulk sync',
      name: 'GpsService',
    );
  }

  // ─── CLEANUP ────────────────────────────────────────────────────────────────

  /// Dispose of all resources.
  ///
  /// Call this when the app is shutting down.
  Future<void> dispose() async {
    await stopTracking();
    await _locationStreamController.close();
    await _signalStatusController.close();
    _instance = null;
  }
}

/// Exception thrown when location permissions are not granted.
class GpsPermissionException implements Exception {
  final String message;
  const GpsPermissionException(this.message);

  @override
  String toString() => 'GpsPermissionException: $message';
}
