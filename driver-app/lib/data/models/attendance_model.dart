import 'package:equatable/equatable.dart';

/// Attendance status for a student on a trip.
enum AttendanceStatus {
  boarded,
  absent,
  droppedOff;

  static AttendanceStatus fromString(String value) {
    switch (value) {
      case 'boarded':
        return AttendanceStatus.boarded;
      case 'absent':
        return AttendanceStatus.absent;
      case 'dropped_off':
        return AttendanceStatus.droppedOff;
      default:
        return AttendanceStatus.absent;
    }
  }

  String toDbValue() {
    switch (this) {
      case AttendanceStatus.boarded:
        return 'boarded';
      case AttendanceStatus.absent:
        return 'absent';
      case AttendanceStatus.droppedOff:
        return 'dropped_off';
    }
  }

  String get displayName {
    switch (this) {
      case AttendanceStatus.boarded:
        return 'Boarded';
      case AttendanceStatus.absent:
        return 'Absent';
      case AttendanceStatus.droppedOff:
        return 'Dropped Off';
    }
  }
}

/// Model representing an attendance record for a student on a trip.
class AttendanceModel extends Equatable {
  final String? id;
  final String tenantId;
  final String tripId;
  final String studentId;
  final String stopId;
  final AttendanceStatus status;
  final DateTime recordedAt;
  final double? latitude;
  final double? longitude;
  final bool syncedFromOffline;

  const AttendanceModel({
    this.id,
    required this.tenantId,
    required this.tripId,
    required this.studentId,
    required this.stopId,
    required this.status,
    required this.recordedAt,
    this.latitude,
    this.longitude,
    this.syncedFromOffline = false,
  });

  factory AttendanceModel.fromJson(Map<String, dynamic> json) {
    return AttendanceModel(
      id: json['id'] as String?,
      tenantId: json['tenant_id'] as String,
      tripId: json['trip_id'] as String,
      studentId: json['student_id'] as String,
      stopId: json['stop_id'] as String,
      status: AttendanceStatus.fromString(json['status'] as String),
      recordedAt: DateTime.parse(json['recorded_at'] as String),
      latitude: (json['latitude'] as num?)?.toDouble(),
      longitude: (json['longitude'] as num?)?.toDouble(),
      syncedFromOffline: json['synced_from_offline'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'tenant_id': tenantId,
        'trip_id': tripId,
        'student_id': studentId,
        'stop_id': stopId,
        'status': status.toDbValue(),
        'recorded_at': recordedAt.toIso8601String(),
        'latitude': latitude,
        'longitude': longitude,
        'synced_from_offline': syncedFromOffline,
      };

  @override
  List<Object?> get props => [
        id,
        tenantId,
        tripId,
        studentId,
        stopId,
        status,
        recordedAt,
        latitude,
        longitude,
        syncedFromOffline,
      ];
}
