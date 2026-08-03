import 'dart:async';
import 'dart:developer' as developer;

import 'package:supabase_flutter/supabase_flutter.dart';

/// Thin wrapper around the Supabase client for all transport Driver App API calls.
///
/// Provides methods for:
/// - Authentication (sign in, sign out, session management)
/// - Edge Function invocation (start-trip, end-trip, record-attendance, sync-offline-data, store-gps-location)
/// - Realtime subscriptions (GPS location channels, trip updates)
/// - Direct database queries (trips, routes, students)
///
/// All methods include proper error handling and logging.
/// Validates: Requirements 6.2, 6.7, 12.5
class TransportSupabaseService {
  TransportSupabaseService._();

  static TransportSupabaseService? _instance;

  /// Singleton instance for consistent access across the app.
  static TransportSupabaseService get instance {
    _instance ??= TransportSupabaseService._();
    return _instance!;
  }

  /// The underlying Supabase client.
  SupabaseClient get client => Supabase.instance.client;

  /// Current authenticated user, or null if not signed in.
  User? get currentUser => client.auth.currentUser;

  /// Current session, or null if not authenticated.
  Session? get currentSession => client.auth.currentSession;

  /// Tenant ID from user metadata.
  String? get tenantId =>
      currentUser?.userMetadata?['tenant_id'] as String?;

  /// Driver's user ID.
  String? get driverId => currentUser?.id;

  // ─── AUTHENTICATION ─────────────────────────────────────────────────────────

  /// Sign in with email and password.
  /// Returns the authenticated session or throws on failure.
  Future<AuthResponse> signIn({
    required String email,
    required String password,
  }) async {
    try {
      final response = await client.auth.signInWithPassword(
        email: email,
        password: password,
      );
      developer.log(
        'Driver signed in: ${response.user?.id}',
        name: 'TransportSupabaseService',
      );
      return response;
    } catch (e) {
      developer.log(
        'Sign in failed: $e',
        name: 'TransportSupabaseService',
        level: 1000,
      );
      rethrow;
    }
  }

  /// Sign out the current user and clean up session.
  Future<void> signOut() async {
    try {
      await client.auth.signOut();
      developer.log('Driver signed out', name: 'TransportSupabaseService');
    } catch (e) {
      developer.log(
        'Sign out error: $e',
        name: 'TransportSupabaseService',
        level: 900,
      );
      rethrow;
    }
  }

  /// Stream of auth state changes for reactive UI updates.
  Stream<AuthState> get authStateChanges => client.auth.onAuthStateChange;

  // ─── EDGE FUNCTION INVOCATION ───────────────────────────────────────────────

  /// Invoke the `start-trip` Edge Function to mark a trip as in-progress.
  Future<Map<String, dynamic>> startTrip({required String tripId}) async {
    return _invokeFunction('start-trip', body: {'trip_id': tripId});
  }

  /// Invoke the `end-trip` Edge Function to mark a trip as completed.
  Future<Map<String, dynamic>> endTrip({required String tripId}) async {
    return _invokeFunction('end-trip', body: {'trip_id': tripId});
  }

  /// Invoke the `record-attendance` Edge Function.
  Future<Map<String, dynamic>> recordAttendance({
    required String tripId,
    required String studentId,
    required String stopId,
    required String status, // 'boarded', 'absent', 'dropped_off'
    required double latitude,
    required double longitude,
    DateTime? recordedAt,
  }) async {
    return _invokeFunction('record-attendance', body: {
      'trip_id': tripId,
      'student_id': studentId,
      'stop_id': stopId,
      'status': status,
      'latitude': latitude,
      'longitude': longitude,
      'recorded_at': (recordedAt ?? DateTime.now()).toUtc().toIso8601String(),
    });
  }

  /// Invoke the `store-gps-location` Edge Function to persist a GPS point.
  Future<Map<String, dynamic>> storeGpsLocation({
    required String tripId,
    required double latitude,
    required double longitude,
    required DateTime recordedAt,
    double? speedKmh,
    double? heading,
    bool syncedFromOffline = false,
  }) async {
    return _invokeFunction('store-gps-location', body: {
      'trip_id': tripId,
      'latitude': latitude,
      'longitude': longitude,
      'recorded_at': recordedAt.toUtc().toIso8601String(),
      if (speedKmh != null) 'speed_kmh': speedKmh,
      if (heading != null) 'heading': heading,
      'synced_from_offline': syncedFromOffline,
    });
  }

  /// Invoke the `sync-offline-data` Edge Function to batch-sync queued records.
  Future<Map<String, dynamic>> syncOfflineData({
    required List<Map<String, dynamic>> attendanceRecords,
    required List<Map<String, dynamic>> gpsLocations,
  }) async {
    return _invokeFunction('sync-offline-data', body: {
      'attendance_records': attendanceRecords,
      'gps_locations': gpsLocations,
    });
  }

  /// Generic Edge Function invocation with error handling.
  Future<Map<String, dynamic>> _invokeFunction(
    String functionName, {
    required Map<String, dynamic> body,
  }) async {
    try {
      developer.log(
        'Invoking Edge Function: $functionName',
        name: 'TransportSupabaseService',
      );

      final response = await client.functions.invoke(
        functionName,
        body: body,
      );

      if (response.status != 200) {
        final errorMsg =
            'Edge Function "$functionName" returned status ${response.status}';
        developer.log(
          errorMsg,
          name: 'TransportSupabaseService',
          level: 1000,
        );
        throw TransportApiException(
          functionName: functionName,
          statusCode: response.status,
          message: response.data?.toString() ?? errorMsg,
        );
      }

      final data = response.data;
      if (data is Map<String, dynamic>) {
        return data;
      }
      return {'data': data};
    } on FunctionException catch (e) {
      developer.log(
        'FunctionException on "$functionName": ${e.details}',
        name: 'TransportSupabaseService',
        level: 1000,
      );
      throw TransportApiException(
        functionName: functionName,
        statusCode: e.status ?? 500,
        message: e.details?.toString() ?? 'Edge Function error',
      );
    } catch (e) {
      if (e is TransportApiException) rethrow;
      developer.log(
        'Unexpected error invoking "$functionName": $e',
        name: 'TransportSupabaseService',
        level: 1000,
      );
      rethrow;
    }
  }

  // ─── REALTIME SUBSCRIPTIONS ─────────────────────────────────────────────────

  /// Subscribe to a trip's GPS location channel for broadcasting.
  ///
  /// Returns the [RealtimeChannel] which can be used to publish GPS updates
  /// and should be unsubscribed when the trip ends.
  RealtimeChannel subscribeTripLocationChannel({required String tripId}) {
    final channelName = 'trip:$tripId:location';
    developer.log(
      'Subscribing to Realtime channel: $channelName',
      name: 'TransportSupabaseService',
    );

    final channel = client.channel(channelName);
    channel.subscribe();
    return channel;
  }

  /// Publish a GPS location update to the trip's Realtime channel.
  Future<void> publishGpsLocation({
    required RealtimeChannel channel,
    required double latitude,
    required double longitude,
    required DateTime timestamp,
    double? speedKmh,
    double? heading,
  }) async {
    try {
      await channel.sendBroadcastMessage(
        event: 'gps_update',
        payload: {
          'latitude': latitude,
          'longitude': longitude,
          'timestamp': timestamp.toUtc().toIso8601String(),
          if (speedKmh != null) 'speed_kmh': speedKmh,
          if (heading != null) 'heading': heading,
        },
      );
    } catch (e) {
      developer.log(
        'Failed to publish GPS to Realtime: $e',
        name: 'TransportSupabaseService',
        level: 900,
      );
      // Non-fatal: GPS storage via Edge Function is the primary persistence path
    }
  }

  /// Unsubscribe from a Realtime channel (call when trip ends).
  Future<void> unsubscribeChannel(RealtimeChannel channel) async {
    try {
      await client.removeChannel(channel);
      developer.log(
        'Unsubscribed from Realtime channel',
        name: 'TransportSupabaseService',
      );
    } catch (e) {
      developer.log(
        'Error unsubscribing channel: $e',
        name: 'TransportSupabaseService',
        level: 900,
      );
    }
  }

  // ─── DATABASE QUERIES (DRIVER-FACING) ───────────────────────────────────────

  /// Fetch today's trips for the current driver, sorted by departure time.
  Future<List<Map<String, dynamic>>> getTodayTrips() async {
    final today = DateTime.now().toIso8601String().split('T')[0];
    final userId = driverId;
    if (userId == null) {
      throw StateError('No authenticated driver');
    }

    final response = await client
        .from('transport_trips')
        .select('*, transport_routes(route_name, school_name), transport_vehicles(registration_number)')
        .eq('driver_id', userId)
        .eq('trip_date', today)
        .order('scheduled_departure', ascending: true);

    return List<Map<String, dynamic>>.from(response);
  }

  /// Fetch the stops for a given route in order.
  Future<List<Map<String, dynamic>>> getRouteStops({
    required String routeId,
  }) async {
    final response = await client
        .from('transport_stops')
        .select()
        .eq('route_id', routeId)
        .order('stop_order', ascending: true);

    return List<Map<String, dynamic>>.from(response);
  }

  /// Fetch students assigned to a specific stop on a route.
  Future<List<Map<String, dynamic>>> getStudentsAtStop({
    required String stopId,
    required String routeId,
  }) async {
    final response = await client
        .from('transport_students')
        .select()
        .eq('assigned_route_id', routeId)
        .eq('assigned_stop_id', stopId)
        .eq('status', 'active');

    return List<Map<String, dynamic>>.from(response);
  }

  /// Fetch attendance records for a trip.
  Future<List<Map<String, dynamic>>> getTripAttendance({
    required String tripId,
  }) async {
    final response = await client
        .from('transport_attendance')
        .select('*, transport_students(full_name)')
        .eq('trip_id', tripId)
        .order('recorded_at', ascending: true);

    return List<Map<String, dynamic>>.from(response);
  }
}

/// Custom exception for transport API errors.
class TransportApiException implements Exception {
  final String functionName;
  final int statusCode;
  final String message;

  const TransportApiException({
    required this.functionName,
    required this.statusCode,
    required this.message,
  });

  @override
  String toString() =>
      'TransportApiException(function: $functionName, status: $statusCode, message: $message)';
}
