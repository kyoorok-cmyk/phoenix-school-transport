import 'package:equatable/equatable.dart';

/// Model representing a stop on a transport route.
class StopModel extends Equatable {
  final String id;
  final String routeId;
  final String tenantId;
  final String stopName;
  final double latitude;
  final double longitude;
  final int geofenceRadiusMeters;
  final int stopOrder;

  const StopModel({
    required this.id,
    required this.routeId,
    required this.tenantId,
    required this.stopName,
    required this.latitude,
    required this.longitude,
    required this.geofenceRadiusMeters,
    required this.stopOrder,
  });

  factory StopModel.fromJson(Map<String, dynamic> json) {
    return StopModel(
      id: json['id'] as String,
      routeId: json['route_id'] as String,
      tenantId: json['tenant_id'] as String,
      stopName: json['stop_name'] as String,
      latitude: (json['latitude'] as num).toDouble(),
      longitude: (json['longitude'] as num).toDouble(),
      geofenceRadiusMeters: json['geofence_radius_meters'] as int? ?? 100,
      stopOrder: json['stop_order'] as int,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'route_id': routeId,
        'tenant_id': tenantId,
        'stop_name': stopName,
        'latitude': latitude,
        'longitude': longitude,
        'geofence_radius_meters': geofenceRadiusMeters,
        'stop_order': stopOrder,
      };

  @override
  List<Object?> get props => [
        id,
        routeId,
        tenantId,
        stopName,
        latitude,
        longitude,
        geofenceRadiusMeters,
        stopOrder,
      ];
}
