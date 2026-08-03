import 'dart:async';
import 'dart:developer' as developer;

import 'package:supabase_flutter/supabase_flutter.dart';

import '../database/local_database.dart';

/// Result of a sync operation for a single batch.
class SyncBatchResult {
  /// Number of records successfully synced.
  final int synced;

  /// Number of records that failed to sync.
  final int failed;

  /// Error message if the entire batch failed.
  final String? error;

  /// IDs of records that were successfully synced.
  final List<int> syncedIds;

  /// IDs of records that failed to sync.
  final List<int> failedIds;

  SyncBatchResult({
    required this.synced,
    required this.failed,
    this.error,
    this.syncedIds = const [],
    this.failedIds = const [],
  });

  bool get hasErrors => failed > 0 || error != null;
  bool get isSuccess => !hasErrors;
}

/// Overall result of a full sync cycle (attendance + GPS).
class OfflineSyncResult {
  /// Result for attendance record sync.
  final SyncBatchResult attendance;

  /// Result for GPS location sync.
  final SyncBatchResult gps;

  /// Total duration of the sync operation.
  final Duration duration;

  OfflineSyncResult({
    required this.attendance,
    required this.gps,
    required this.duration,
  });

  /// Total records synced across all categories.
  int get totalSynced => attendance.synced + gps.synced;

  /// Total records failed across all categories.
  int get totalFailed => attendance.failed + gps.failed;

  /// Whether the entire sync completed without errors.
  bool get isSuccess => !attendance.hasErrors && !gps.hasErrors;

  @override
  String toString() =>
      'OfflineSyncResult(attendance: ${attendance.synced}/${attendance.synced + attendance.failed}, '
      'gps: ${gps.synced}/${gps.synced + gps.failed}, duration: ${duration.inMilliseconds}ms)';
}

/// Sync status for progress tracking.
enum OfflineSyncStatus {
  /// No sync in progress, idle.
  idle,

  /// Currently syncing attendance records.
  syncingAttendance,

  /// Currently syncing GPS locations.
  syncingGps,

  /// Sync completed successfully.
  completed,

  /// Sync completed with errors.
  completedWithErrors,
}

/// Manages offline data synchronization for the Driver App.
///
/// Handles FIFO queue management for attendance records and GPS location
/// data, submitting them in batches to the Supabase `sync-offline-data`
/// Edge Function when connectivity is restored.
///
/// Key behaviors:
/// - Records are stored with timestamps and synced in FIFO order
/// - Automatic sync on connectivity restoration (triggered by ConnectivityMonitor)
/// - Batch submission of queued records
/// - Handles partial failures gracefully (retry failed items)
///
/// Validates: Requirements 12.1, 12.2, 12.3, 12.5
class OfflineSyncService {
  final SupabaseClient _supabaseClient;

  /// Maximum number of records per sync batch.
  static const int batchSize = 50;

  /// Maximum retry attempts per record before marking as permanently failed.
  static const int maxRetries = 3;

  /// Delay between retry attempts (exponential backoff base).
  static const Duration retryBaseDelay = Duration(seconds: 2);

  bool _isSyncing = false;
  DateTime? _lastSyncTime;

  /// Stream controller for sync status changes.
  final StreamController<OfflineSyncStatus> _statusController =
      StreamController<OfflineSyncStatus>.broadcast();

  /// Stream of sync status updates for UI consumption.
  Stream<OfflineSyncStatus> get statusStream => _statusController.stream;

  /// Current sync status.
  OfflineSyncStatus _currentStatus = OfflineSyncStatus.idle;
  OfflineSyncStatus get currentStatus => _currentStatus;

  /// Whether a sync is currently in progress.
  bool get isSyncing => _isSyncing;

  /// Timestamp of the last successful sync.
  DateTime? get lastSyncTime => _lastSyncTime;

  /// Callback for sync progress notifications.
  void Function(String message)? onSyncProgress;

  /// Callback for sync error notifications.
  void Function(String message)? onSyncError;

  /// Create an OfflineSyncService instance.
  ///
  /// Accepts an optional [SupabaseClient] for dependency injection (testing).
  OfflineSyncService({SupabaseClient? supabaseClient})
      : _supabaseClient = supabaseClient ?? Supabase.instance.client;

  // ===========================================================================
  // Queue Operations — Attendance
  // ===========================================================================

  /// Queue an attendance record for offline sync.
  ///
  /// The record is stored locally in SQLite and will be synced
  /// to the server when connectivity is restored, in FIFO order.
  Future<int> queueAttendanceRecord({
    required String tripId,
    required String studentId,
    required String stopId,
    required String status,
    required DateTime recordedAt,
    double? latitude,
    double? longitude,
  }) async {
    return await TransportLocalDatabase.insertPendingAttendance(
      tripId: tripId,
      studentId: studentId,
      stopId: stopId,
      status: status,
      recordedAt: recordedAt,
      latitude: latitude,
      longitude: longitude,
    );
  }

  // ===========================================================================
  // Queue Operations — GPS
  // ===========================================================================

  /// Queue a GPS location record for offline sync.
  ///
  /// GPS data is stored locally and transmitted as a full track
  /// upon reconnection, preserving the FIFO order by recorded_at.
  Future<int> queueGpsLocation({
    required String tripId,
    required double latitude,
    required double longitude,
    required DateTime recordedAt,
    double? speedKmh,
    double? heading,
  }) async {
    return await TransportLocalDatabase.insertPendingGpsLocation(
      tripId: tripId,
      latitude: latitude,
      longitude: longitude,
      recordedAt: recordedAt,
      speedKmh: speedKmh,
      heading: heading,
    );
  }

  // ===========================================================================
  // Sync Operations
  // ===========================================================================

  /// Synchronize all pending offline data (attendance + GPS) to the server.
  ///
  /// This is the primary entry point called by [TransportConnectivityMonitor]
  /// when connectivity is restored. Records are processed in FIFO order
  /// (by recorded_at timestamp ascending).
  ///
  /// Handles partial failures: if a batch fails, individual records are
  /// retried up to [maxRetries] times. Records exceeding the retry limit
  /// remain in the queue marked as failed.
  Future<OfflineSyncResult> syncAll() async {
    if (_isSyncing) {
      return OfflineSyncResult(
        attendance: SyncBatchResult(synced: 0, failed: 0, error: 'Sync already in progress'),
        gps: SyncBatchResult(synced: 0, failed: 0),
        duration: Duration.zero,
      );
    }

    _isSyncing = true;
    final stopwatch = Stopwatch()..start();

    SyncBatchResult attendanceResult;
    SyncBatchResult gpsResult;

    try {
      // Reset any previously failed records for retry
      await TransportLocalDatabase.resetFailedAttendance();
      await TransportLocalDatabase.resetFailedGps();

      // Sync attendance first (higher priority — triggers notifications)
      _updateStatus(OfflineSyncStatus.syncingAttendance);
      attendanceResult = await _syncAttendanceRecords();

      // Sync GPS locations
      _updateStatus(OfflineSyncStatus.syncingGps);
      gpsResult = await _syncGpsLocations();

      // Update last sync time on any success
      if (attendanceResult.synced > 0 || gpsResult.synced > 0) {
        _lastSyncTime = DateTime.now();
      }

      final hasErrors = attendanceResult.hasErrors || gpsResult.hasErrors;
      _updateStatus(hasErrors
          ? OfflineSyncStatus.completedWithErrors
          : OfflineSyncStatus.completed);
    } catch (e) {
      developer.log('Sync failed with error: $e', name: 'OfflineSyncService');
      onSyncError?.call('Sync failed: $e');
      attendanceResult = SyncBatchResult(synced: 0, failed: 0, error: e.toString());
      gpsResult = SyncBatchResult(synced: 0, failed: 0);
      _updateStatus(OfflineSyncStatus.completedWithErrors);
    } finally {
      _isSyncing = false;
      stopwatch.stop();

      // Return to idle after a short delay
      Future.delayed(const Duration(seconds: 2), () {
        if (_currentStatus != OfflineSyncStatus.syncingAttendance &&
            _currentStatus != OfflineSyncStatus.syncingGps) {
          _updateStatus(OfflineSyncStatus.idle);
        }
      });
    }

    final result = OfflineSyncResult(
      attendance: attendanceResult,
      gps: gpsResult,
      duration: stopwatch.elapsed,
    );

    developer.log('Sync completed: $result', name: 'OfflineSyncService');
    onSyncProgress?.call(
        'Synced ${result.totalSynced} records (${result.totalFailed} failed)');

    return result;
  }

  /// Sync all pending attendance records in batches.
  Future<SyncBatchResult> _syncAttendanceRecords() async {
    int totalSynced = 0;
    int totalFailed = 0;
    final allSyncedIds = <int>[];
    final allFailedIds = <int>[];

    while (true) {
      final records = await TransportLocalDatabase.getPendingAttendance(
        limit: batchSize,
      );

      if (records.isEmpty) break;

      final ids = records.map((r) => r['id'] as int).toList();

      // Mark records as syncing to prevent re-processing
      await TransportLocalDatabase.markAttendanceSyncing(ids);

      try {
        // Build the batch payload in FIFO order (already sorted by recorded_at ASC)
        final payload = records.map((r) => {
              'trip_id': r['trip_id'],
              'student_id': r['student_id'],
              'stop_id': r['stop_id'],
              'status': r['status'],
              'recorded_at': r['recorded_at'],
              'latitude': r['latitude'],
              'longitude': r['longitude'],
            }).toList();

        // Call the sync-offline-data Edge Function
        final response = await _supabaseClient.functions.invoke(
          'sync-offline-data',
          body: {
            'type': 'attendance',
            'records': payload,
          },
        );

        if (response.status == 200) {
          // Success — remove synced records
          await TransportLocalDatabase.deleteAttendanceRecords(ids);
          totalSynced += ids.length;
          allSyncedIds.addAll(ids);
        } else {
          // Server returned an error — handle partial failure
          final responseData = response.data;
          if (responseData is Map && responseData.containsKey('failed_indices')) {
            // Some records failed — handle individually
            final failedIndices =
                (responseData['failed_indices'] as List).cast<int>();
            final successIds = <int>[];
            final failIds = <int>[];

            for (int i = 0; i < ids.length; i++) {
              if (failedIndices.contains(i)) {
                failIds.add(ids[i]);
              } else {
                successIds.add(ids[i]);
              }
            }

            // Remove successful records
            await TransportLocalDatabase.deleteAttendanceRecords(successIds);
            totalSynced += successIds.length;
            allSyncedIds.addAll(successIds);

            // Mark failed records for retry
            await TransportLocalDatabase.markAttendanceFailed(
                failIds, responseData['error'] ?? 'Partial batch failure');
            totalFailed += failIds.length;
            allFailedIds.addAll(failIds);
          } else {
            // Entire batch failed — mark all for retry
            final errorMsg = responseData is Map
                ? (responseData['error'] ?? 'Server error: ${response.status}')
                : 'Server error: ${response.status}';
            await TransportLocalDatabase.markAttendanceFailed(
                ids, errorMsg.toString());
            totalFailed += ids.length;
            allFailedIds.addAll(ids);
          }
        }
      } catch (e) {
        // Network or unexpected error — mark batch as failed for retry
        developer.log('Attendance sync batch failed: $e',
            name: 'OfflineSyncService');
        await TransportLocalDatabase.markAttendanceFailed(
            ids, e.toString());
        totalFailed += ids.length;
        allFailedIds.addAll(ids);

        // Stop processing further batches on network errors
        break;
      }
    }

    // Remove records that have exceeded max retry count
    await _pruneExceededRetries('attendance');

    return SyncBatchResult(
      synced: totalSynced,
      failed: totalFailed,
      syncedIds: allSyncedIds,
      failedIds: allFailedIds,
    );
  }

  /// Sync all pending GPS locations in batches.
  Future<SyncBatchResult> _syncGpsLocations() async {
    int totalSynced = 0;
    int totalFailed = 0;
    final allSyncedIds = <int>[];
    final allFailedIds = <int>[];

    while (true) {
      final records = await TransportLocalDatabase.getPendingGpsLocations(
        limit: batchSize,
      );

      if (records.isEmpty) break;

      final ids = records.map((r) => r['id'] as int).toList();

      // Mark records as syncing
      await TransportLocalDatabase.markGpsSyncing(ids);

      try {
        // Build the batch payload in FIFO order (already sorted by recorded_at ASC)
        final payload = records.map((r) => {
              'trip_id': r['trip_id'],
              'latitude': r['latitude'],
              'longitude': r['longitude'],
              'recorded_at': r['recorded_at'],
              'speed_kmh': r['speed_kmh'],
              'heading': r['heading'],
            }).toList();

        // Call the sync-offline-data Edge Function
        final response = await _supabaseClient.functions.invoke(
          'sync-offline-data',
          body: {
            'type': 'gps_locations',
            'records': payload,
          },
        );

        if (response.status == 200) {
          // Success — remove synced records
          await TransportLocalDatabase.deleteGpsRecords(ids);
          totalSynced += ids.length;
          allSyncedIds.addAll(ids);
        } else {
          // Server returned an error — handle partial failure
          final responseData = response.data;
          if (responseData is Map && responseData.containsKey('failed_indices')) {
            final failedIndices =
                (responseData['failed_indices'] as List).cast<int>();
            final successIds = <int>[];
            final failIds = <int>[];

            for (int i = 0; i < ids.length; i++) {
              if (failedIndices.contains(i)) {
                failIds.add(ids[i]);
              } else {
                successIds.add(ids[i]);
              }
            }

            await TransportLocalDatabase.deleteGpsRecords(successIds);
            totalSynced += successIds.length;
            allSyncedIds.addAll(successIds);

            await TransportLocalDatabase.markGpsFailed(
                failIds, responseData['error'] ?? 'Partial batch failure');
            totalFailed += failIds.length;
            allFailedIds.addAll(failIds);
          } else {
            final errorMsg = responseData is Map
                ? (responseData['error'] ?? 'Server error: ${response.status}')
                : 'Server error: ${response.status}';
            await TransportLocalDatabase.markGpsFailed(
                ids, errorMsg.toString());
            totalFailed += ids.length;
            allFailedIds.addAll(ids);
          }
        }
      } catch (e) {
        developer.log('GPS sync batch failed: $e',
            name: 'OfflineSyncService');
        await TransportLocalDatabase.markGpsFailed(ids, e.toString());
        totalFailed += ids.length;
        allFailedIds.addAll(ids);

        // Stop processing further batches on network errors
        break;
      }
    }

    // Remove records that have exceeded max retry count
    await _pruneExceededRetries('gps');

    return SyncBatchResult(
      synced: totalSynced,
      failed: totalFailed,
      syncedIds: allSyncedIds,
      failedIds: allFailedIds,
    );
  }

  /// Remove records that have exceeded [maxRetries] attempts.
  ///
  /// These records are permanently discarded to prevent queue bloat.
  /// A notification is emitted so the UI can inform the driver.
  Future<void> _pruneExceededRetries(String type) async {
    final db = await TransportLocalDatabase.database;
    final table =
        type == 'attendance' ? 'pending_attendance' : 'pending_gps_locations';

    final exceededRecords = await db.query(
      table,
      where: 'retry_count >= ? AND sync_status = ?',
      whereArgs: [maxRetries, 'failed'],
    );

    if (exceededRecords.isNotEmpty) {
      final ids = exceededRecords.map((r) => r['id'] as int).toList();
      final placeholders = ids.map((_) => '?').join(',');
      await db.rawDelete(
        'DELETE FROM $table WHERE id IN ($placeholders)',
        ids,
      );

      onSyncError?.call(
          '${ids.length} $type record(s) could not be synced after $maxRetries attempts and were removed.');
      developer.log(
          'Pruned ${ids.length} $type records exceeding max retries',
          name: 'OfflineSyncService');
    }
  }

  // ===========================================================================
  // Status and Query Operations
  // ===========================================================================

  /// Get the total number of records pending sync.
  Future<int> getPendingCount() async {
    return await TransportLocalDatabase.getTotalPendingCount();
  }

  /// Get a breakdown of pending records by type.
  Future<Map<String, int>> getPendingBreakdown() async {
    final attendance = await TransportLocalDatabase.getPendingAttendanceCount();
    final gps = await TransportLocalDatabase.getPendingGpsCount();
    return {
      'attendance': attendance,
      'gps': gps,
      'total': attendance + gps,
    };
  }

  void _updateStatus(OfflineSyncStatus newStatus) {
    if (newStatus != _currentStatus) {
      _currentStatus = newStatus;
      _statusController.add(newStatus);
    }
  }

  /// Clean up resources.
  void dispose() {
    _statusController.close();
  }
}
