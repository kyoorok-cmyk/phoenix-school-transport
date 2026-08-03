import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/trip_bloc.dart';
import '../data/models/trip_model.dart';
import 'active_trip_screen.dart';

/// TripListScreen displays all trips assigned to the current driver for today
/// in chronological order (sorted by scheduled_departure).
///
/// Requirements: 6.1 - WHEN a driver opens the Driver_App, THE Driver_App
/// SHALL display the list of trips assigned for the current day in
/// chronological order.
class TripListScreen extends StatelessWidget {
  const TripListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => TripBloc()..add(const LoadTodayTrips()),
      child: const _TripListView(),
    );
  }
}

class _TripListView extends StatelessWidget {
  const _TripListView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Today\'s Trips'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh trips',
            onPressed: () {
              context.read<TripBloc>().add(const RefreshTrips());
            },
          ),
        ],
      ),
      body: BlocConsumer<TripBloc, TripState>(
        listener: (context, state) {
          if (state is TripError) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(state.message),
                backgroundColor: Colors.red.shade700,
                behavior: SnackBarBehavior.floating,
              ),
            );
          }
        },
        builder: (context, state) {
          if (state is TripLoading) {
            return const Center(
              child: CircularProgressIndicator(),
            );
          }

          if (state is TripListLoaded) {
            if (state.trips.isEmpty) {
              return _buildEmptyState();
            }
            return _buildTripList(context, state.trips);
          }

          if (state is TripError && state.previousState is TripListLoaded) {
            final trips = (state.previousState as TripListLoaded).trips;
            return _buildTripList(context, trips);
          }

          return _buildEmptyState();
        },
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.directions_bus_outlined,
            size: 80,
            color: Colors.grey.shade400,
          ),
          const SizedBox(height: 16),
          Text(
            'No trips assigned for today',
            style: TextStyle(
              fontSize: 18,
              color: Colors.grey.shade600,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Pull down to refresh',
            style: TextStyle(
              fontSize: 14,
              color: Colors.grey.shade500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTripList(BuildContext context, List<TripModel> trips) {
    return RefreshIndicator(
      onRefresh: () async {
        context.read<TripBloc>().add(const RefreshTrips());
        // Wait for state change
        await context.read<TripBloc>().stream.firstWhere(
              (state) => state is TripListLoaded || state is TripError,
            );
      },
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        itemCount: trips.length,
        itemBuilder: (context, index) {
          return _TripCard(
            trip: trips[index],
            onTap: () => _navigateToActiveTrip(context, trips[index]),
          );
        },
      ),
    );
  }

  void _navigateToActiveTrip(BuildContext context, TripModel trip) {
    final bloc = context.read<TripBloc>();
    bloc.add(SelectTrip(trip));

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => BlocProvider.value(
          value: bloc,
          child: const ActiveTripScreen(),
        ),
      ),
    );
  }
}

/// Card widget displaying a single trip in the list.
class _TripCard extends StatelessWidget {
  final TripModel trip;
  final VoidCallback onTap;

  const _TripCard({
    required this.trip,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      trip.routeName ?? 'Route',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  _StatusChip(status: trip.status),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(
                    Icons.school_outlined,
                    size: 16,
                    color: Colors.grey.shade600,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      trip.schoolName ?? 'School',
                      style: TextStyle(
                        fontSize: 14,
                        color: Colors.grey.shade700,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Icon(
                    Icons.access_time,
                    size: 16,
                    color: Colors.grey.shade600,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _formatTime(trip.scheduledDeparture),
                    style: TextStyle(
                      fontSize: 14,
                      color: Colors.grey.shade700,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(width: 16),
                  _TripTypeChip(tripType: trip.tripType),
                ],
              ),
              if (trip.vehicleRegistration != null) ...[
                const SizedBox(height: 6),
                Row(
                  children: [
                    Icon(
                      Icons.directions_bus,
                      size: 16,
                      color: Colors.grey.shade600,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      trip.vehicleRegistration!,
                      style: TextStyle(
                        fontSize: 13,
                        color: Colors.grey.shade600,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// Format HH:mm:ss time string to HH:mm for display.
  String _formatTime(String timeStr) {
    final parts = timeStr.split(':');
    if (parts.length >= 2) {
      return '${parts[0]}:${parts[1]}';
    }
    return timeStr;
  }
}

/// Color-coded status chip for trip status.
class _StatusChip extends StatelessWidget {
  final TripStatus status;

  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: _backgroundColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _borderColor, width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: _indicatorColor,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            status.displayName,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: _textColor,
            ),
          ),
        ],
      ),
    );
  }

  Color get _indicatorColor {
    switch (status) {
      case TripStatus.scheduled:
        return Colors.blue;
      case TripStatus.inProgress:
        return Colors.orange;
      case TripStatus.completed:
        return Colors.green;
      case TripStatus.cancelled:
        return Colors.red;
    }
  }

  Color get _backgroundColor {
    switch (status) {
      case TripStatus.scheduled:
        return Colors.blue.shade50;
      case TripStatus.inProgress:
        return Colors.orange.shade50;
      case TripStatus.completed:
        return Colors.green.shade50;
      case TripStatus.cancelled:
        return Colors.red.shade50;
    }
  }

  Color get _borderColor {
    switch (status) {
      case TripStatus.scheduled:
        return Colors.blue.shade200;
      case TripStatus.inProgress:
        return Colors.orange.shade200;
      case TripStatus.completed:
        return Colors.green.shade200;
      case TripStatus.cancelled:
        return Colors.red.shade200;
    }
  }

  Color get _textColor {
    switch (status) {
      case TripStatus.scheduled:
        return Colors.blue.shade800;
      case TripStatus.inProgress:
        return Colors.orange.shade800;
      case TripStatus.completed:
        return Colors.green.shade800;
      case TripStatus.cancelled:
        return Colors.red.shade800;
    }
  }
}

/// Chip showing trip type (morning/afternoon).
class _TripTypeChip extends StatelessWidget {
  final TripType tripType;

  const _TripTypeChip({required this.tripType});

  @override
  Widget build(BuildContext context) {
    final isMorning = tripType == TripType.morningPickup;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: isMorning ? Colors.amber.shade50 : Colors.indigo.shade50,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            isMorning ? Icons.wb_sunny_outlined : Icons.wb_twilight,
            size: 14,
            color: isMorning ? Colors.amber.shade800 : Colors.indigo.shade700,
          ),
          const SizedBox(width: 4),
          Text(
            tripType.displayName,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color:
                  isMorning ? Colors.amber.shade800 : Colors.indigo.shade700,
            ),
          ),
        ],
      ),
    );
  }
}
