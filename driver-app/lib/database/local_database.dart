import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// Local SQLite database for the Driver App's offline transport operations.
///
/// Stores pending attendance records, GPS location data, and cached
/// trip/student information for offline display and FIFO sync.
///
/// Tables:
/// - `pending_attendance` — attendance records awaiting server sync
/// - `pending_gps_locations` — GPS positions queued for sync
/// - `cached_trips` — full trip data for offline display
/// - `cached_students` — students by route for offline attendance marking
class TransportLocalDatabase {
  static Database? _database;
  static const int _dbVersion = 1;
  static const String _dbName = 'phoenix_transport_driver.db';

  /// Get or initialize the database singleton.
  static Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDatabase();
    return _database!;
  }

  /// Initialize the database explicitly (useful at app startup).
  static Future<Database> initDatabase() async {
    _database = await _initDatabase();
    return _database!;
  }

  static Future<Database> _initDatabase() async {
    final documentsDir = await getApplicationDocumentsDirectory();
    final path = join(documentsDir.path, _dbName);

    return await openDatabase(
      path,
      version: _dbVersion,
      onCreate: _onCreate,
      onUpgrade: _onUpgrade,
    );
  }

  static Future<void> _onCreate(Database db, int version) async {
    await _createPendingAttendanceTable(db);
    await _createPendingGpsLocationsTable(db);
    await _createCachedTripsTable(db);
    await _createCachedStudentsTable(db);
    await _createIndexes(db);
  }

  static Future<void> _createPendingAttendanceTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS pending_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        stop_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('boarded', 'absent', 'dropped_off')),
        recorded_at TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createPendingGpsLocationsTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS pending_gps_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        speed_kmh REAL,
        heading REAL,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createCachedTripsTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS cached_trips (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        route_name TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        trip_date TEXT NOT NULL,
        trip_type TEXT NOT NULL,
        scheduled_departure TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        school_name TEXT,
        stops_json TEXT NOT NULL DEFAULT '[]',
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createCachedStudentsTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS cached_students (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        grade TEXT NOT NULL,
        school_name TEXT NOT NULL,
        assigned_route_id TEXT NOT NULL,
        assigned_stop_id TEXT NOT NULL,
        stop_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createIndexes(Database db) async {
    // Pending attendance indexes
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_attendance_trip ON pending_attendance(trip_id)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_attendance_sync ON pending_attendance(sync_status)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_attendance_recorded ON pending_attendance(recorded_at ASC)');

    // Pending GPS locations indexes
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_gps_trip ON pending_gps_locations(trip_id)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_gps_sync ON pending_gps_locations(sync_status)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_pending_gps_recorded ON pending_gps_locations(recorded_at ASC)');

    // Cached trips indexes
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_cached_trips_driver ON cached_trips(driver_id)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_cached_trips_date ON cached_trips(trip_date)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_cached_trips_route ON cached_trips(route_id)');

    // Cached students indexes
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_cached_students_route ON cached_students(assigned_route_id)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_cached_students_stop ON cached_students(assigned_stop_id)');
  }

  static Future<void> _onUpgrade(
      Database db, int oldVersion, int newVersion) async {
    if (oldVersion < newVersion) {
      await db.execute('DROP TABLE IF EXISTS pending_attendance');
      await db.execute('DROP TABLE IF EXISTS pending_gps_locations');
      await db.execute('DROP TABLE IF EXISTS cached_trips');
      await db.execute('DROP TABLE IF EXISTS cached_students');
      await _onCreate(db, newVersion);
    }
  }

  // ===========================================================================
  // Pending Attendance CRUD Operations
  // ===========================================================================

  /// Insert a new pending attendance record.
  ///
  /// Returns the auto-generated row ID.
  static Future<int> insertPendingAttendance({
    required String tripId,
    required String studentId,
    required String stopId,
    required String status,
    required DateTime recordedAt,
    double? latitude,
    double? longitude,
  }) async {
    final db = await database;
    return await db.insert('pending_attendance', {
      'trip_id': tripId,
      'student_id': studentId,
      'stop_id': stopId,
      'status': status,
      'recorded_at': recordedAt.toUtc().toIso8601String(),
      'latitude': latitude,
      'longitude': longitude,
      'sync_status': 'pending',
      'retry_count': 0,
      'created_at': DateTime.now().toUtc().toIso8601String(),
    });
  }

  /// Get all pending attendance records in FIFO order (by recorded_at ASC).
  static Future<List<Map<String, dynamic>>> getPendingAttendance({
    String syncStatus = 'pending',
    int? limit,
  }) async {
    final db = await database;
    return await db.query(
      'pending_attendance',
      where: 'sync_status = ?',
      whereArgs: [syncStatus],
      orderBy: 'recorded_at ASC',
      limit: limit,
    );
  }

  /// Get all pending attendance records for a specific trip.
  static Future<List<Map<String, dynamic>>> getPendingAttendanceForTrip(
      String tripId) async {
    final db = await database;
    return await db.query(
      'pending_attendance',
      where: 'trip_id = ?',
      whereArgs: [tripId],
      orderBy: 'recorded_at ASC',
    );
  }

  /// Get count of pending attendance records.
  static Future<int> getPendingAttendanceCount() async {
    final db = await database;
    final result = await db.rawQuery(
        'SELECT COUNT(*) as count FROM pending_attendance WHERE sync_status = ?',
        ['pending']);
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// Mark attendance records as syncing (in-progress).
  static Future<void> markAttendanceSyncing(List<int> ids) async {
    if (ids.isEmpty) return;
    final db = await database;
    final placeholders = ids.map((_) => '?').join(',');
    await db.rawUpdate(
      'UPDATE pending_attendance SET sync_status = ? WHERE id IN ($placeholders)',
      ['syncing', ...ids],
    );
  }

  /// Delete successfully synced attendance records.
  static Future<void> deleteAttendanceRecords(List<int> ids) async {
    if (ids.isEmpty) return;
    final db = await database;
    final placeholders = ids.map((_) => '?').join(',');
    await db.rawDelete(
      'DELETE FROM pending_attendance WHERE id IN ($placeholders)',
      ids,
    );
  }

  /// Mark attendance records as failed with an error message.
  static Future<void> markAttendanceFailed(List<int> ids, String error) async {
    if (ids.isEmpty) return;
    final db = await database;
    final batch = db.batch();
    for (final id in ids) {
      batch.rawUpdate(
        'UPDATE pending_attendance SET sync_status = ?, last_error = ?, retry_count = retry_count + 1 WHERE id = ?',
        ['failed', error, id],
      );
    }
    await batch.commit(noResult: true);
  }

  /// Reset failed attendance records back to pending for retry.
  static Future<void> resetFailedAttendance() async {
    final db = await database;
    await db.update(
      'pending_attendance',
      {'sync_status': 'pending', 'last_error': null},
      where: 'sync_status = ?',
      whereArgs: ['failed'],
    );
  }

  // ===========================================================================
  // Pending GPS Locations CRUD Operations
  // ===========================================================================

  /// Insert a new pending GPS location record.
  ///
  /// Returns the auto-generated row ID.
  static Future<int> insertPendingGpsLocation({
    required String tripId,
    required double latitude,
    required double longitude,
    required DateTime recordedAt,
    double? speedKmh,
    double? heading,
  }) async {
    final db = await database;
    return await db.insert('pending_gps_locations', {
      'trip_id': tripId,
      'latitude': latitude,
      'longitude': longitude,
      'recorded_at': recordedAt.toUtc().toIso8601String(),
      'speed_kmh': speedKmh,
      'heading': heading,
      'sync_status': 'pending',
      'retry_count': 0,
      'created_at': DateTime.now().toUtc().toIso8601String(),
    });
  }

  /// Get all pending GPS locations in FIFO order (by recorded_at ASC).
  static Future<List<Map<String, dynamic>>> getPendingGpsLocations({
    String syncStatus = 'pending',
    int? limit,
  }) async {
    final db = await database;
    return await db.query(
      'pending_gps_locations',
      where: 'sync_status = ?',
      whereArgs: [syncStatus],
      orderBy: 'recorded_at ASC',
      limit: limit,
    );
  }

  /// Get all pending GPS locations for a specific trip.
  static Future<List<Map<String, dynamic>>> getPendingGpsForTrip(
      String tripId) async {
    final db = await database;
    return await db.query(
      'pending_gps_locations',
      where: 'trip_id = ?',
      whereArgs: [tripId],
      orderBy: 'recorded_at ASC',
    );
  }

  /// Get count of pending GPS location records.
  static Future<int> getPendingGpsCount() async {
    final db = await database;
    final result = await db.rawQuery(
        'SELECT COUNT(*) as count FROM pending_gps_locations WHERE sync_status = ?',
        ['pending']);
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// Mark GPS records as syncing (in-progress).
  static Future<void> markGpsSyncing(List<int> ids) async {
    if (ids.isEmpty) return;
    final db = await database;
    final placeholders = ids.map((_) => '?').join(',');
    await db.rawUpdate(
      'UPDATE pending_gps_locations SET sync_status = ? WHERE id IN ($placeholders)',
      ['syncing', ...ids],
    );
  }

  /// Delete successfully synced GPS records.
  static Future<void> deleteGpsRecords(List<int> ids) async {
    if (ids.isEmpty) return;
    final db = await database;
    final placeholders = ids.map((_) => '?').join(',');
    await db.rawDelete(
      'DELETE FROM pending_gps_locations WHERE id IN ($placeholders)',
      ids,
    );
  }

  /// Mark GPS records as failed with an error message.
  static Future<void> markGpsFailed(List<int> ids, String error) async {
    if (ids.isEmpty) return;
    final db = await database;
    final batch = db.batch();
    for (final id in ids) {
      batch.rawUpdate(
        'UPDATE pending_gps_locations SET sync_status = ?, last_error = ?, retry_count = retry_count + 1 WHERE id = ?',
        ['failed', error, id],
      );
    }
    await batch.commit(noResult: true);
  }

  /// Reset failed GPS records back to pending for retry.
  static Future<void> resetFailedGps() async {
    final db = await database;
    await db.update(
      'pending_gps_locations',
      {'sync_status': 'pending', 'last_error': null},
      where: 'sync_status = ?',
      whereArgs: ['failed'],
    );
  }

  // ===========================================================================
  // Cached Trips CRUD Operations
  // ===========================================================================

  /// Cache trip data for offline display.
  ///
  /// Replaces all existing cached trips for the given driver with fresh data.
  static Future<void> cacheTrips(
      String driverId, List<Map<String, dynamic>> trips) async {
    final db = await database;
    final batch = db.batch();
    final now = DateTime.now().toUtc().toIso8601String();

    // Clear existing cached trips for this driver
    batch.delete('cached_trips', where: 'driver_id = ?', whereArgs: [driverId]);

    for (final trip in trips) {
      batch.insert(
        'cached_trips',
        {
          'id': trip['id'],
          'tenant_id': trip['tenant_id'],
          'schedule_id': trip['schedule_id'],
          'route_id': trip['route_id'],
          'route_name': trip['route_name'] ?? '',
          'vehicle_id': trip['vehicle_id'],
          'driver_id': trip['driver_id'],
          'trip_date': trip['trip_date'],
          'trip_type': trip['trip_type'],
          'scheduled_departure': trip['scheduled_departure'],
          'status': trip['status'] ?? 'scheduled',
          'school_name': trip['school_name'],
          'stops_json': trip['stops_json'] ?? '[]',
          'cached_at': now,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }

    await batch.commit(noResult: true);
  }

  /// Get cached trips for a driver on a specific date.
  ///
  /// Returns trips ordered by scheduled_departure ASC (chronological).
  static Future<List<Map<String, dynamic>>> getCachedTrips({
    required String driverId,
    String? tripDate,
  }) async {
    final db = await database;
    String where = 'driver_id = ?';
    List<dynamic> whereArgs = [driverId];

    if (tripDate != null) {
      where += ' AND trip_date = ?';
      whereArgs.add(tripDate);
    }

    return await db.query(
      'cached_trips',
      where: where,
      whereArgs: whereArgs,
      orderBy: 'scheduled_departure ASC',
    );
  }

  /// Get a single cached trip by ID.
  static Future<Map<String, dynamic>?> getCachedTripById(String tripId) async {
    final db = await database;
    final results = await db.query(
      'cached_trips',
      where: 'id = ?',
      whereArgs: [tripId],
    );
    return results.isNotEmpty ? results.first : null;
  }

  /// Update the status of a cached trip.
  static Future<void> updateCachedTripStatus(
      String tripId, String newStatus) async {
    final db = await database;
    await db.update(
      'cached_trips',
      {'status': newStatus},
      where: 'id = ?',
      whereArgs: [tripId],
    );
  }

  // ===========================================================================
  // Cached Students CRUD Operations
  // ===========================================================================

  /// Cache student data for offline attendance marking.
  ///
  /// Replaces all cached students for the given route with fresh data.
  static Future<void> cacheStudentsForRoute(
      String routeId, List<Map<String, dynamic>> students) async {
    final db = await database;
    final batch = db.batch();
    final now = DateTime.now().toUtc().toIso8601String();

    // Clear existing cached students for this route
    batch.delete('cached_students',
        where: 'assigned_route_id = ?', whereArgs: [routeId]);

    for (final student in students) {
      batch.insert(
        'cached_students',
        {
          'id': student['id'],
          'tenant_id': student['tenant_id'],
          'full_name': student['full_name'],
          'grade': student['grade'],
          'school_name': student['school_name'],
          'assigned_route_id': student['assigned_route_id'],
          'assigned_stop_id': student['assigned_stop_id'],
          'stop_name': student['stop_name'],
          'status': student['status'] ?? 'active',
          'cached_at': now,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }

    await batch.commit(noResult: true);
  }

  /// Get cached students for a specific route.
  ///
  /// Returns active students ordered by full_name.
  static Future<List<Map<String, dynamic>>> getCachedStudentsForRoute(
      String routeId) async {
    final db = await database;
    return await db.query(
      'cached_students',
      where: 'assigned_route_id = ? AND status = ?',
      whereArgs: [routeId, 'active'],
      orderBy: 'full_name ASC',
    );
  }

  /// Get cached students for a specific stop.
  ///
  /// Returns active students assigned to the given stop.
  static Future<List<Map<String, dynamic>>> getCachedStudentsForStop(
      String stopId) async {
    final db = await database;
    return await db.query(
      'cached_students',
      where: 'assigned_stop_id = ? AND status = ?',
      whereArgs: [stopId, 'active'],
      orderBy: 'full_name ASC',
    );
  }

  /// Get a single cached student by ID.
  static Future<Map<String, dynamic>?> getCachedStudentById(
      String studentId) async {
    final db = await database;
    final results = await db.query(
      'cached_students',
      where: 'id = ?',
      whereArgs: [studentId],
    );
    return results.isNotEmpty ? results.first : null;
  }

  // ===========================================================================
  // Utility Operations
  // ===========================================================================

  /// Get total count of all pending records (attendance + GPS).
  static Future<int> getTotalPendingCount() async {
    final attendanceCount = await getPendingAttendanceCount();
    final gpsCount = await getPendingGpsCount();
    return attendanceCount + gpsCount;
  }

  /// Close the database connection.
  static Future<void> close() async {
    final db = _database;
    if (db != null) {
      await db.close();
      _database = null;
    }
  }

  /// Reset all data (useful for logout or testing).
  static Future<void> reset() async {
    final db = await database;
    await db.delete('pending_attendance');
    await db.delete('pending_gps_locations');
    await db.delete('cached_trips');
    await db.delete('cached_students');
  }

  /// Delete only cached data, preserving pending sync records.
  static Future<void> clearCache() async {
    final db = await database;
    await db.delete('cached_trips');
    await db.delete('cached_students');
  }
}
