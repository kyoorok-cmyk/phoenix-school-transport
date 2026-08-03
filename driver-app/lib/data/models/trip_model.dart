import 'package:equatable/equatable.dart';

/// Represents a trip's execution status.
enum TripStatus {
  scheduled,
  inProgress,
  completed,
  cancelled;

  static TripStatus fromString(String value) {
    switch (value) {
      case 'in_progress':
        return TripStatus.inProgress;
      case 'completed':
        return TripStatus.completed;
      case 'cancelled':
        return TripStatus.cancelled;
      case 'scheduled':
      default:
        return TripStatus.scheduled;
    }
  }

  String toDbValue() {
    switch (this) {
      case TripStatus.inProgress:
        return 'in_progress';
      case TripStatus.completed:
        return 'completed';
      case TripStatus.cancelled:
        return 'cancelled';
      case TripStatus.scheduled:
        return 'scheduled';
    }
  }

  String get displayName {
    switch (this) {
      case TripStatus.scheduled:
        return 'Scheduled';
      case TripStatus.inProgress:
        return 'In Progress';
      case TripStatus.completed:
        return 'Completed';
      case TripStatus.cancelled:
        return 'Cancelled';
    }
  }
}

/// Represents the trip type (morning pickup or afternoon drop-off).
enum TripType {
  morningPickup,
  afternoonDropoff;

  static TripType fromString(String value) {
    switch (value) {
      case 'afternoon_dropoff':
        return TripType.afternoonDropoff;
      case 'morning_pickup':
      default:
        return TripType.morningPickup;
    }
  }

  String toDbValue() {
    switch (this) {
      case TripType.morningPickup:
        return 'morning_pickup';
      case TripType.afternoonDropoff:
        return 'afternoon_dropoff';
    }
  }

  String get displayName {
    switch (this) {
      case TripType.morningPickup:
        return 'Morning Pickup';
      case TripType.afternoonDropoff:
        return 'Afternoon Drop-off';
    }
  }
}

/// Model representing a transport trip assigned to a driver.
class TripModel extends Equatable {
  final String id;
  final String tenantId;
  final String scheduleId;
  final String routeId;
  final String vehicleId;
  final String driverId;
  final DateTime tripDate;
  final TripType tripType;
  final String scheduledDeparture; // TIME as HH:mm:ss
  final DateTime? actualDeparture;
  final DateTime? actualCompletion;
  final TripStatus status;
  final String? cancellationReason;
  final String? routeName;
  final String? schoolName;
  final String? vehicleRegistration;

  const TripModel({
    required this.id,
    required this.tenantId,
    required this.scheduleId,
    required this.routeId,
    required this.vehicleId,
    required this.driverId,
    required this.tripDate,
    required this.tripType,
    required this.scheduledDeparture,
    this.actualDeparture,
    this.actualCompletion,
    required this.status,
    this.cancellationReason,
    this.routeName,
    this.schoolName,
    this.vehicleRegistration,
  });

  factory TripModel.fromJson(Map<String, dynamic> json) {
    // Route info may come from a join
    final route = json['transport_routes'] as Map<String, dynamic>?;
    final vehicle = json['transport_vehicles'] as Map<String, dynamic>?;

    return TripModel(
      id: json['id'] as String,
      tenantId: json['tenant_id'] as String,
      scheduleId: json['schedule_id'] as String,
      routeId: json['route_id'] as String,
      vehicleId: json['vehicle_id'] as String,
      driverId: json['driver_id'] as String,
      tripDate: DateTime.parse(json['trip_date'] as String),
      tripType: TripType.fromString(json['trip_type'] as String),
      scheduledDeparture: json['scheduled_departure'] as String,
      actualDeparture: json['actual_departure'] != null
          ? DateTime.parse(json['actual_departure'] as String)
          : null,
      actualCompletion: json['actual_completion'] != null
          ? DateTime.parse(json['actual_completion'] as String)
          : null,
      status: TripStatus.fromString(json['status'] as String),
      cancellationReason: json['cancellation_reason'] as String?,
      routeName: route?['route_name'] as String? ?? json['route_name'] as String?,
      schoolName: route?['school_name'] as String? ?? json['school_name'] as String?,
      vehicleRegistration: vehicle?['registration_number'] as String? ??
          json['vehicle_registration'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'tenant_id': tenantId,
        'schedule_id': scheduleId,
        'route_id': routeId,
        'vehicle_id': vehicleId,
        'driver_id': driverId,
        'trip_date': tripDate.toIso8601String().split('T')[0],
        'trip_type': tripType.toDbValue(),
        'scheduled_departure': scheduledDeparture,
        'actual_departure': actualDeparture?.toIso8601String(),
        'actual_completion': actualCompletion?.toIso8601String(),
        'status': status.toDbValue(),
        'cancellation_reason': cancellationReason,
      };

  TripModel copyWith({
    TripStatus? status,
    DateTime? actualDeparture,
    DateTime? actualCompletion,
  }) {
    return TripModel(
      id: id,
      tenantId: tenantId,
      scheduleId: scheduleId,
      routeId: routeId,
      vehicleId: vehicleId,
      driverId: driverId,
      tripDate: tripDate,
      tripType: tripType,
      scheduledDeparture: scheduledDeparture,
      actualDeparture: actualDeparture ?? this.actualDeparture,
      actualCompletion: actualCompletion ?? this.actualCompletion,
      status: status ?? this.status,
      cancellationReason: cancellationReason,
      routeName: routeName,
      schoolName: schoolName,
      vehicleRegistration: vehicleRegistration,
    );
  }

  @override
  List<Object?> get props => [
        id,
        tenantId,
        scheduleId,
        routeId,
        vehicleId,
        driverId,
        tripDate,
        tripType,
        scheduledDeparture,
        actualDeparture,
        actualCompletion,
        status,
        cancellationReason,
      ];
}
