import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/trip_bloc.dart';
import '../data/models/attendance_model.dart';
import '../data/models/stop_model.dart';
import '../data/models/student_model.dart';
import '../data/models/trip_model.dart';

/// ActiveTripScreen manages the driver's active trip execution.
///
/// Features:
/// - Start Trip button (calls start-trip Edge Function)
/// - Shows route stops in order with progress indicator
/// - When vehicle enters geofence, displays student list for that stop
/// - Attendance marking: board/absent toggle for each student
/// - End Trip button when all stops completed
/// - GPS signal status indicator
///
/// Requirements: 6.2, 6.3, 6.4, 6.5, 6.6
class ActiveTripScreen extends StatelessWidget {
  const ActiveTripScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<TripBloc, TripState>(
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
          return Scaffold(
            appBar: AppBar(title: const Text('Trip')),
            body: const Center(child: CircularProgressIndicator()),
          );
        }

        if (state is ActiveTripState) {
          return _ActiveTripContent(state: state);
        }

        // Fallback — should not normally reach here
        return Scaffold(
          appBar: AppBar(title: const Text('Trip')),
          body: const Center(
            child: Text('No active trip selected'),
          ),
        );
      },
    );
  }
}

class _ActiveTripContent extends StatelessWidget {
  final ActiveTripState state;

  const _ActiveTripContent({required this.state});

  @override
  Widget build(BuildContext context) {
    final trip = state.trip;
    final isScheduled = trip.status == TripStatus.scheduled;
    final isInProgress = trip.status == TripStatus.inProgress;
    final isCompleted = trip.status == TripStatus.completed;

    return Scaffold(
      appBar: AppBar(
        title: Text(trip.routeName ?? 'Active Trip'),
        actions: [
          _GpsSignalIndicator(
            hasSignal: state.hasGpsSignal,
            lastFixTime: state.lastGpsFixTime,
          ),
        ],
      ),
      body: Column(
        children: [
          // Trip info header
          _TripInfoHeader(trip: trip),

          // Stop progress
          if (state.stops.isNotEmpty)
            _StopProgressBar(
              totalStops: state.stops.length,
              completedStops: state.completedStopsCount,
            ),

          // Main content area
          Expanded(
            child: isInProgress
                ? _InProgressContent(state: state)
                : isCompleted
                    ? _CompletedContent()
                    : _PreStartContent(stops: state.stops),
          ),

          // Bottom action button
          if (isScheduled)
            _StartTripButton(
              tripId: trip.id,
              isLoading: state.isStarting,
            ),
          if (isInProgress && state.allStopsCompleted)
            _EndTripButton(
              tripId: trip.id,
              isLoading: state.isEnding,
            ),
        ],
      ),
    );
  }
}

/// GPS signal status indicator in the app bar.
class _GpsSignalIndicator extends StatelessWidget {
  final bool hasSignal;
  final DateTime? lastFixTime;

  const _GpsSignalIndicator({
    required this.hasSignal,
    this.lastFixTime,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 12),
      child: Tooltip(
        message: hasSignal
            ? 'GPS signal active'
            : 'GPS signal lost${_lastFixLabel}',
        child: Icon(
          hasSignal ? Icons.gps_fixed : Icons.gps_off,
          color: hasSignal ? Colors.greenAccent : Colors.red.shade300,
          size: 22,
        ),
      ),
    );
  }

  String get _lastFixLabel {
    if (lastFixTime == null) return '';
    final diff = DateTime.now().difference(lastFixTime!);
    if (diff.inSeconds < 60) return ' (${diff.inSeconds}s ago)';
    return ' (${diff.inMinutes}m ago)';
  }
}

/// Displays key trip info at the top of the screen.
class _TripInfoHeader extends StatelessWidget {
  final TripModel trip;

  const _TripInfoHeader({required this.trip});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border(
          bottom: BorderSide(color: Colors.grey.shade200),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  trip.schoolName ?? '',
                  style: TextStyle(
                    fontSize: 14,
                    color: Colors.grey.shade700,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(Icons.access_time, size: 14, color: Colors.grey.shade600),
                    const SizedBox(width: 4),
                    Text(
                      _formatTime(trip.scheduledDeparture),
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    if (trip.vehicleRegistration != null) ...[
                      const SizedBox(width: 12),
                      Icon(Icons.directions_bus, size: 14, color: Colors.grey.shade600),
                      const SizedBox(width: 4),
                      Text(
                        trip.vehicleRegistration!,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          _buildStatusBadge(trip.status),
        ],
      ),
    );
  }

  Widget _buildStatusBadge(TripStatus status) {
    final color = _statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        status.displayName,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
    );
  }

  Color _statusColor(TripStatus status) {
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

  String _formatTime(String timeStr) {
    final parts = timeStr.split(':');
    if (parts.length >= 2) return '${parts[0]}:${parts[1]}';
    return timeStr;
  }
}

/// Visual progress bar showing stop completion.
class _StopProgressBar extends StatelessWidget {
  final int totalStops;
  final int completedStops;

  const _StopProgressBar({
    required this.totalStops,
    required this.completedStops,
  });

  @override
  Widget build(BuildContext context) {
    final progress = totalStops > 0 ? completedStops / totalStops : 0.0;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      color: Colors.grey.shade50,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Stop Progress',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Colors.grey.shade700,
                ),
              ),
              Text(
                '$completedStops / $totalStops',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: Colors.grey.shade800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 6,
              backgroundColor: Colors.grey.shade300,
              valueColor: AlwaysStoppedAnimation<Color>(
                progress >= 1.0 ? Colors.green : Colors.blue,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Content shown before the trip is started — just the stop list.
class _PreStartContent extends StatelessWidget {
  final List<StopModel> stops;

  const _PreStartContent({required this.stops});

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: stops.length,
      itemBuilder: (context, index) {
        final stop = stops[index];
        return _StopListTile(
          stop: stop,
          index: index,
          isCompleted: false,
          isCurrent: false,
        );
      },
    );
  }
}

/// Content shown while trip is in progress — stop list + attendance sheet.
class _InProgressContent extends StatelessWidget {
  final ActiveTripState state;

  const _InProgressContent({required this.state});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Stops timeline (compact)
        SizedBox(
          height: 80,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            itemCount: state.stops.length,
            itemBuilder: (context, index) {
              final stop = state.stops[index];
              final isCurrent = state.currentStop?.id == stop.id;
              final isCompleted = index < state.completedStopsCount;
              return _HorizontalStopChip(
                stop: stop,
                isCurrent: isCurrent,
                isCompleted: isCompleted,
              );
            },
          ),
        ),

        const Divider(height: 1),

        // Attendance sheet for current stop
        Expanded(
          child: state.currentStop != null
              ? _AttendanceSheet(
                  tripId: state.trip.id,
                  stop: state.currentStop!,
                  students: state.studentsAtCurrentStop,
                  attendanceRecords: state.attendanceRecords,
                  isRecording: state.isRecordingAttendance,
                )
              : _WaitingForGeofence(),
        ),
      ],
    );
  }
}

/// Shown when waiting for vehicle to arrive at a stop's geofence.
class _WaitingForGeofence extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.location_searching,
            size: 64,
            color: Colors.blue.shade300,
          ),
          const SizedBox(height: 16),
          Text(
            'Approaching next stop...',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w500,
              color: Colors.grey.shade700,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'The student list will appear when you\narrive at the stop geofence',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              color: Colors.grey.shade500,
            ),
          ),
        ],
      ),
    );
  }
}

/// Horizontal chip showing a stop in the timeline.
class _HorizontalStopChip extends StatelessWidget {
  final StopModel stop;
  final bool isCurrent;
  final bool isCompleted;

  const _HorizontalStopChip({
    required this.stop,
    required this.isCurrent,
    required this.isCompleted,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: isCurrent
            ? Colors.blue.shade50
            : isCompleted
                ? Colors.green.shade50
                : Colors.grey.shade100,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: isCurrent
              ? Colors.blue
              : isCompleted
                  ? Colors.green
                  : Colors.grey.shade300,
          width: isCurrent ? 2 : 1,
        ),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            isCompleted
                ? Icons.check_circle
                : isCurrent
                    ? Icons.my_location
                    : Icons.circle_outlined,
            size: 18,
            color: isCurrent
                ? Colors.blue
                : isCompleted
                    ? Colors.green
                    : Colors.grey,
          ),
          const SizedBox(height: 4),
          Text(
            stop.stopName,
            style: TextStyle(
              fontSize: 11,
              fontWeight: isCurrent ? FontWeight.w600 : FontWeight.normal,
              color: isCurrent ? Colors.blue.shade800 : Colors.grey.shade700,
            ),
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

/// AttendanceSheet displays students at the current stop with board/absent toggles.
///
/// Requirements: 6.3, 6.4, 6.5
class _AttendanceSheet extends StatelessWidget {
  final String tripId;
  final StopModel stop;
  final List<StudentModel> students;
  final Map<String, AttendanceStatus> attendanceRecords;
  final bool isRecording;

  const _AttendanceSheet({
    required this.tripId,
    required this.stop,
    required this.students,
    required this.attendanceRecords,
    required this.isRecording,
  });

  @override
  Widget build(BuildContext context) {
    if (students.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            Text(
              'No students assigned to this stop',
              style: TextStyle(color: Colors.grey.shade600),
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Stop header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          color: Colors.blue.shade50,
          child: Row(
            children: [
              const Icon(Icons.location_on, size: 20, color: Colors.blue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  stop.stopName,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                '${_markedCount}/${students.length} marked',
                style: TextStyle(
                  fontSize: 13,
                  color: Colors.grey.shade700,
                ),
              ),
            ],
          ),
        ),

        // Student list with attendance toggles
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: students.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final student = students[index];
              final currentStatus = attendanceRecords[student.id];

              return _StudentAttendanceTile(
                student: student,
                currentStatus: currentStatus,
                isRecording: isRecording,
                onBoard: () => _recordAttendance(
                  context,
                  student.id,
                  AttendanceStatus.boarded,
                ),
                onAbsent: () => _recordAttendance(
                  context,
                  student.id,
                  AttendanceStatus.absent,
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  int get _markedCount =>
      students.where((s) => attendanceRecords.containsKey(s.id)).length;

  void _recordAttendance(
    BuildContext context,
    String studentId,
    AttendanceStatus status,
  ) {
    context.read<TripBloc>().add(
          RecordStudentAttendance(
            tripId: tripId,
            studentId: studentId,
            stopId: stop.id,
            status: status,
          ),
        );
  }
}

/// Single student row with board/absent toggle buttons.
class _StudentAttendanceTile extends StatelessWidget {
  final StudentModel student;
  final AttendanceStatus? currentStatus;
  final bool isRecording;
  final VoidCallback onBoard;
  final VoidCallback onAbsent;

  const _StudentAttendanceTile({
    required this.student,
    this.currentStatus,
    required this.isRecording,
    required this.onBoard,
    required this.onAbsent,
  });

  @override
  Widget build(BuildContext context) {
    final isMarked = currentStatus != null;
    final isBoarded = currentStatus == AttendanceStatus.boarded;
    final isAbsent = currentStatus == AttendanceStatus.absent;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          // Student info
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  student.fullName,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    color: isMarked ? Colors.grey.shade600 : Colors.black87,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Grade ${student.grade}',
                  style: TextStyle(
                    fontSize: 12,
                    color: Colors.grey.shade500,
                  ),
                ),
              ],
            ),
          ),

          // Board button
          _AttendanceToggleButton(
            label: 'Board',
            icon: Icons.check_circle_outline,
            isSelected: isBoarded,
            selectedColor: Colors.green,
            isEnabled: !isRecording,
            onTap: onBoard,
          ),

          const SizedBox(width: 8),

          // Absent button
          _AttendanceToggleButton(
            label: 'Absent',
            icon: Icons.cancel_outlined,
            isSelected: isAbsent,
            selectedColor: Colors.red,
            isEnabled: !isRecording,
            onTap: onAbsent,
          ),
        ],
      ),
    );
  }
}

/// Toggle button for board/absent marking.
class _AttendanceToggleButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool isSelected;
  final Color selectedColor;
  final bool isEnabled;
  final VoidCallback onTap;

  const _AttendanceToggleButton({
    required this.label,
    required this.icon,
    required this.isSelected,
    required this.selectedColor,
    required this.isEnabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: isSelected ? selectedColor.withValues(alpha: 0.1) : Colors.grey.shade100,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: isEnabled ? onTap : null,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: isSelected ? selectedColor : Colors.grey.shade300,
              width: isSelected ? 2 : 1,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                isSelected ? Icons.check_circle : icon,
                size: 16,
                color: isSelected ? selectedColor : Colors.grey.shade600,
              ),
              const SizedBox(width: 4),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
                  color: isSelected ? selectedColor : Colors.grey.shade700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Content shown when trip is completed.
class _CompletedContent extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.check_circle,
            size: 80,
            color: Colors.green.shade400,
          ),
          const SizedBox(height: 16),
          const Text(
            'Trip Completed',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'All stops have been serviced successfully.',
            style: TextStyle(
              fontSize: 14,
              color: Colors.grey.shade600,
            ),
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.arrow_back),
            label: const Text('Back to Trip List'),
          ),
        ],
      ),
    );
  }
}

/// Start Trip button at the bottom of the screen.
class _StartTripButton extends StatelessWidget {
  final String tripId;
  final bool isLoading;

  const _StartTripButton({
    required this.tripId,
    required this.isLoading,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(
            top: BorderSide(color: Colors.grey.shade200),
          ),
        ),
        child: FilledButton.icon(
          onPressed: isLoading
              ? null
              : () {
                  _confirmStartTrip(context);
                },
          icon: isLoading
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Icon(Icons.play_arrow),
          label: Text(isLoading ? 'Starting...' : 'Start Trip'),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
            backgroundColor: Colors.green.shade700,
          ),
        ),
      ),
    );
  }

  void _confirmStartTrip(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Start Trip'),
        content: const Text(
          'This will begin GPS tracking and notify the operator. '
          'Are you ready to start?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              context.read<TripBloc>().add(StartTrip(tripId));
            },
            child: const Text('Start'),
          ),
        ],
      ),
    );
  }
}

/// End Trip button shown when all stops are completed.
class _EndTripButton extends StatelessWidget {
  final String tripId;
  final bool isLoading;

  const _EndTripButton({
    required this.tripId,
    required this.isLoading,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(
            top: BorderSide(color: Colors.grey.shade200),
          ),
        ),
        child: FilledButton.icon(
          onPressed: isLoading
              ? null
              : () {
                  _confirmEndTrip(context);
                },
          icon: isLoading
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Icon(Icons.stop),
          label: Text(isLoading ? 'Ending...' : 'End Trip'),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
            backgroundColor: Colors.red.shade700,
          ),
        ),
      ),
    );
  }

  void _confirmEndTrip(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('End Trip'),
        content: const Text(
          'This will stop GPS tracking and mark the trip as completed. '
          'All stops have been serviced.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              context.read<TripBloc>().add(EndTrip(tripId));
            },
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            child: const Text('End Trip'),
          ),
        ],
      ),
    );
  }
}

/// Stop list tile for the pre-start stop overview.
class _StopListTile extends StatelessWidget {
  final StopModel stop;
  final int index;
  final bool isCompleted;
  final bool isCurrent;

  const _StopListTile({
    required this.stop,
    required this.index,
    required this.isCompleted,
    required this.isCurrent,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Timeline indicator
          Column(
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isCompleted
                      ? Colors.green
                      : isCurrent
                          ? Colors.blue
                          : Colors.grey.shade300,
                ),
                child: Center(
                  child: isCompleted
                      ? const Icon(Icons.check, size: 16, color: Colors.white)
                      : Text(
                          '${index + 1}',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: isCurrent ? Colors.white : Colors.grey.shade700,
                          ),
                        ),
                ),
              ),
              Container(
                width: 2,
                height: 24,
                color: Colors.grey.shade300,
              ),
            ],
          ),
          const SizedBox(width: 12),

          // Stop info
          Expanded(
            child: Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      stop.stopName,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Geofence: ${stop.geofenceRadiusMeters}m radius',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade500,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
