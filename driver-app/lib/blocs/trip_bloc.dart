import 'dart:async';

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../data/models/attendance_model.dart';
import '../data/models/stop_model.dart';
import '../data/models/student_model.dart';
import '../data/models/trip_model.dart';

// ─── Events ──────────────────────────────────────────────────────────────────

abstract class TripEvent extends Equatable {
  const TripEvent();
  @override
  List<Object?> get props => [];
}

/// Load all trips assigned to the current driver for today.
class LoadTodayTrips extends TripEvent {
  const LoadTodayTrips();
}

/// Refresh trips (pull-to-refresh).
class RefreshTrips extends TripEvent {
  const RefreshTrips();
}

/// Select a trip to view details / start active trip mode.
class SelectTrip extends TripEvent {
  final TripModel trip;
  const SelectTrip(this.trip);
  @override
  List<Object?> get props => [trip];
}

/// Start the selected trip (calls start-trip Edge Function).
class StartTrip extends TripEvent {
  final String tripId;
  const StartTrip(this.tripId);
  @override
  List<Object?> get props => [tripId];
}

/// End the active trip (calls end-trip Edge Function).
class EndTrip extends TripEvent {
  final String tripId;
  const EndTrip(this.tripId);
  @override
  List<Object?> get props => [tripId];
}

/// Arrive at a stop (triggered by geofence detection).
class ArriveAtStop extends TripEvent {
  final StopModel stop;
  const ArriveAtStop(this.stop);
  @override
  List<Object?> get props => [stop];
}

/// Record attendance for a student at the current stop.
class RecordStudentAttendance extends TripEvent {
  final String tripId;
  final String studentId;
  final String stopId;
  final AttendanceStatus status;
  final double? latitude;
  final double? longitude;
  const RecordStudentAttendance({
    required this.tripId,
    required this.studentId,
    required this.stopId,
    required this.status,
    this.latitude,
    this.longitude,
  });
  @override
  List<Object?> get props => [tripId, studentId, stopId, status];
}

/// Update GPS signal status for the UI indicator.
class UpdateGpsStatus extends TripEvent {
  final bool hasSignal;
  final DateTime? lastFixTime;
  const UpdateGpsStatus({required this.hasSignal, this.lastFixTime});
  @override
  List<Object?> get props => [hasSignal, lastFixTime];
}

// ─── States ──────────────────────────────────────────────────────────────────

abstract class TripState extends Equatable {
  const TripState();
  @override
  List<Object?> get props => [];
}

/// Initial state before any data is loaded.
class TripInitial extends TripState {
  const TripInitial();
}

/// Loading trips from the server.
class TripLoading extends TripState {
  const TripLoading();
}

/// Trips loaded successfully for the day.
class TripListLoaded extends TripState {
  final List<TripModel> trips;

  const TripListLoaded(this.trips);

  @override
  List<Object?> get props => [trips];
}

/// A single trip is selected and active details are loaded.
class ActiveTripState extends TripState {
  final TripModel trip;
  final List<StopModel> stops;
  final List<StudentModel> studentsAtCurrentStop;
  final Map<String, AttendanceStatus> attendanceRecords;
  final StopModel? currentStop;
  final int completedStopsCount;
  final bool hasGpsSignal;
  final DateTime? lastGpsFixTime;
  final bool isStarting;
  final bool isEnding;
  final bool isRecordingAttendance;

  const ActiveTripState({
    required this.trip,
    required this.stops,
    this.studentsAtCurrentStop = const [],
    this.attendanceRecords = const {},
    this.currentStop,
    this.completedStopsCount = 0,
    this.hasGpsSignal = true,
    this.lastGpsFixTime,
    this.isStarting = false,
    this.isEnding = false,
    this.isRecordingAttendance = false,
  });

  bool get allStopsCompleted => completedStopsCount >= stops.length;

  ActiveTripState copyWith({
    TripModel? trip,
    List<StopModel>? stops,
    List<StudentModel>? studentsAtCurrentStop,
    Map<String, AttendanceStatus>? attendanceRecords,
    StopModel? currentStop,
    int? completedStopsCount,
    bool? hasGpsSignal,
    DateTime? lastGpsFixTime,
    bool? isStarting,
    bool? isEnding,
    bool? isRecordingAttendance,
  }) {
    return ActiveTripState(
      trip: trip ?? this.trip,
      stops: stops ?? this.stops,
      studentsAtCurrentStop:
          studentsAtCurrentStop ?? this.studentsAtCurrentStop,
      attendanceRecords: attendanceRecords ?? this.attendanceRecords,
      currentStop: currentStop ?? this.currentStop,
      completedStopsCount: completedStopsCount ?? this.completedStopsCount,
      hasGpsSignal: hasGpsSignal ?? this.hasGpsSignal,
      lastGpsFixTime: lastGpsFixTime ?? this.lastGpsFixTime,
      isStarting: isStarting ?? this.isStarting,
      isEnding: isEnding ?? this.isEnding,
      isRecordingAttendance:
          isRecordingAttendance ?? this.isRecordingAttendance,
    );
  }

  @override
  List<Object?> get props => [
        trip,
        stops,
        studentsAtCurrentStop,
        attendanceRecords,
        currentStop,
        completedStopsCount,
        hasGpsSignal,
        lastGpsFixTime,
        isStarting,
        isEnding,
        isRecordingAttendance,
      ];
}

/// Error state with a message.
class TripError extends TripState {
  final String message;
  final TripState? previousState;

  const TripError(this.message, {this.previousState});

  @override
  List<Object?> get props => [message, previousState];
}

// ─── BLoC ────────────────────────────────────────────────────────────────────

/// BLoC managing trip state for the driver app.
///
/// Handles loading daily trips, starting/ending trips,
/// navigating stops, and recording attendance.
class TripBloc extends Bloc<TripEvent, TripState> {
  TripBloc() : super(const TripInitial()) {
    on<LoadTodayTrips>(_onLoadTodayTrips);
    on<RefreshTrips>(_onRefreshTrips);
    on<SelectTrip>(_onSelectTrip);
    on<StartTrip>(_onStartTrip);
    on<EndTrip>(_onEndTrip);
    on<ArriveAtStop>(_onArriveAtStop);
    on<RecordStudentAttendance>(_onRecordStudentAttendance);
    on<UpdateGpsStatus>(_onUpdateGpsStatus);
  }

  SupabaseClient get _client => Supabase.instance.client;

  String get _currentUserId => _client.auth.currentUser!.id;

  String get _todayDate {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
  }

  /// Load trips assigned to the current driver for today,
  /// sorted by scheduled_departure ascending.
  Future<void> _onLoadTodayTrips(
    LoadTodayTrips event,
    Emitter<TripState> emit,
  ) async {
    emit(const TripLoading());
    try {
      final trips = await _fetchTodayTrips();
      emit(TripListLoaded(trips));
    } catch (e) {
      emit(TripError('Failed to load trips: ${e.toString()}'));
    }
  }

  /// Pull-to-refresh handler re-fetches trips.
  Future<void> _onRefreshTrips(
    RefreshTrips event,
    Emitter<TripState> emit,
  ) async {
    try {
      final trips = await _fetchTodayTrips();
      emit(TripListLoaded(trips));
    } catch (e) {
      emit(TripError(
        'Failed to refresh trips: ${e.toString()}',
        previousState: state,
      ));
    }
  }

  /// Select a trip and load its route stops.
  Future<void> _onSelectTrip(
    SelectTrip event,
    Emitter<TripState> emit,
  ) async {
    emit(const TripLoading());
    try {
      final stops = await _fetchStopsForRoute(event.trip.routeId);
      emit(ActiveTripState(
        trip: event.trip,
        stops: stops,
        completedStopsCount: 0,
      ));
    } catch (e) {
      emit(TripError('Failed to load trip details: ${e.toString()}'));
    }
  }

  /// Start a trip by calling the start-trip Edge Function.
  Future<void> _onStartTrip(
    StartTrip event,
    Emitter<TripState> emit,
  ) async {
    final currentState = state;
    if (currentState is! ActiveTripState) return;

    emit(currentState.copyWith(isStarting: true));

    try {
      await _client.functions.invoke(
        'start-trip',
        body: {'trip_id': event.tripId},
      );

      final updatedTrip = currentState.trip.copyWith(
        status: TripStatus.inProgress,
        actualDeparture: DateTime.now(),
      );

      emit(currentState.copyWith(
        trip: updatedTrip,
        isStarting: false,
      ));
    } catch (e) {
      emit(currentState.copyWith(isStarting: false));
      emit(TripError(
        'Failed to start trip: ${e.toString()}',
        previousState: currentState,
      ));
    }
  }

  /// End the active trip by calling the end-trip Edge Function.
  Future<void> _onEndTrip(
    EndTrip event,
    Emitter<TripState> emit,
  ) async {
    final currentState = state;
    if (currentState is! ActiveTripState) return;

    emit(currentState.copyWith(isEnding: true));

    try {
      await _client.functions.invoke(
        'end-trip',
        body: {'trip_id': event.tripId},
      );

      final updatedTrip = currentState.trip.copyWith(
        status: TripStatus.completed,
        actualCompletion: DateTime.now(),
      );

      emit(currentState.copyWith(
        trip: updatedTrip,
        isEnding: false,
      ));
    } catch (e) {
      emit(currentState.copyWith(isEnding: false));
      emit(TripError(
        'Failed to end trip: ${e.toString()}',
        previousState: currentState,
      ));
    }
  }

  /// Handle arriving at a stop (triggered externally by geofence detection).
  /// Loads students assigned to this stop.
  Future<void> _onArriveAtStop(
    ArriveAtStop event,
    Emitter<TripState> emit,
  ) async {
    final currentState = state;
    if (currentState is! ActiveTripState) return;

    try {
      final students = await _fetchStudentsForStop(
        event.stop.id,
        currentState.trip.routeId,
      );

      emit(currentState.copyWith(
        currentStop: event.stop,
        studentsAtCurrentStop: students,
      ));
    } catch (e) {
      emit(TripError(
        'Failed to load students for stop: ${e.toString()}',
        previousState: currentState,
      ));
    }
  }

  /// Record attendance for a single student at the current stop.
  Future<void> _onRecordStudentAttendance(
    RecordStudentAttendance event,
    Emitter<TripState> emit,
  ) async {
    final currentState = state;
    if (currentState is! ActiveTripState) return;

    emit(currentState.copyWith(isRecordingAttendance: true));

    try {
      await _client.functions.invoke(
        'record-attendance',
        body: {
          'trip_id': event.tripId,
          'student_id': event.studentId,
          'stop_id': event.stopId,
          'status': event.status.toDbValue(),
          'latitude': event.latitude,
          'longitude': event.longitude,
          'recorded_at': DateTime.now().toIso8601String(),
        },
      );

      final updatedRecords =
          Map<String, AttendanceStatus>.from(currentState.attendanceRecords);
      updatedRecords[event.studentId] = event.status;

      // Check if all students at this stop have been marked
      final allMarked = currentState.studentsAtCurrentStop.every(
        (s) => updatedRecords.containsKey(s.id),
      );

      final newCompletedCount = allMarked
          ? currentState.completedStopsCount + 1
          : currentState.completedStopsCount;

      emit(currentState.copyWith(
        attendanceRecords: updatedRecords,
        completedStopsCount: newCompletedCount,
        isRecordingAttendance: false,
      ));
    } catch (e) {
      emit(currentState.copyWith(isRecordingAttendance: false));
      emit(TripError(
        'Failed to record attendance: ${e.toString()}',
        previousState: currentState,
      ));
    }
  }

  /// Update the GPS signal status indicator.
  void _onUpdateGpsStatus(
    UpdateGpsStatus event,
    Emitter<TripState> emit,
  ) {
    final currentState = state;
    if (currentState is! ActiveTripState) return;

    emit(currentState.copyWith(
      hasGpsSignal: event.hasSignal,
      lastGpsFixTime: event.lastFixTime,
    ));
  }

  // ─── Data Fetching ─────────────────────────────────────────────────────────

  /// Fetch today's trips for the current driver, sorted by scheduled_departure.
  Future<List<TripModel>> _fetchTodayTrips() async {
    final response = await _client
        .from('transport_trips')
        .select('''
          *,
          transport_routes(route_name, school_name),
          transport_vehicles(registration_number)
        ''')
        .eq('driver_id', _currentUserId)
        .eq('trip_date', _todayDate)
        .order('scheduled_departure', ascending: true);

    final data = List<Map<String, dynamic>>.from(response);
    return data.map((json) => TripModel.fromJson(json)).toList();
  }

  /// Fetch stops for a route, ordered by stop_order.
  Future<List<StopModel>> _fetchStopsForRoute(String routeId) async {
    final response = await _client
        .from('transport_stops')
        .select()
        .eq('route_id', routeId)
        .order('stop_order', ascending: true);

    final data = List<Map<String, dynamic>>.from(response);
    return data.map((json) => StopModel.fromJson(json)).toList();
  }

  /// Fetch active students assigned to a specific stop on a route.
  Future<List<StudentModel>> _fetchStudentsForStop(
    String stopId,
    String routeId,
  ) async {
    final response = await _client
        .from('transport_students')
        .select()
        .eq('assigned_stop_id', stopId)
        .eq('assigned_route_id', routeId)
        .eq('status', 'active')
        .order('full_name', ascending: true);

    final data = List<Map<String, dynamic>>.from(response);
    return data.map((json) => StudentModel.fromJson(json)).toList();
  }
}
