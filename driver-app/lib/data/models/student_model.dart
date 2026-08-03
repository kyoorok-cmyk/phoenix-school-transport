import 'package:equatable/equatable.dart';

/// Model representing a student assigned to a route/stop.
class StudentModel extends Equatable {
  final String id;
  final String tenantId;
  final String fullName;
  final String grade;
  final String schoolName;
  final String? assignedRouteId;
  final String? assignedStopId;
  final String status;

  const StudentModel({
    required this.id,
    required this.tenantId,
    required this.fullName,
    required this.grade,
    required this.schoolName,
    this.assignedRouteId,
    this.assignedStopId,
    required this.status,
  });

  factory StudentModel.fromJson(Map<String, dynamic> json) {
    return StudentModel(
      id: json['id'] as String,
      tenantId: json['tenant_id'] as String,
      fullName: json['full_name'] as String,
      grade: json['grade'] as String,
      schoolName: json['school_name'] as String,
      assignedRouteId: json['assigned_route_id'] as String?,
      assignedStopId: json['assigned_stop_id'] as String?,
      status: json['status'] as String? ?? 'active',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'tenant_id': tenantId,
        'full_name': fullName,
        'grade': grade,
        'school_name': schoolName,
        'assigned_route_id': assignedRouteId,
        'assigned_stop_id': assignedStopId,
        'status': status,
      };

  @override
  List<Object?> get props => [
        id,
        tenantId,
        fullName,
        grade,
        schoolName,
        assignedRouteId,
        assignedStopId,
        status,
      ];
}
