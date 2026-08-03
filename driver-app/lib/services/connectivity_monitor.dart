import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';

import 'offline_sync_service.dart';

/// Connectivity state representing online/offline status.
enum ConnectionState {
  /// Device has network connectivity.
  online,

  /// Device has no network connectivity.
  offline,
}

/// Monitors network connectivity for the Driver App.
///
/// Detects transitions between online and offline states and triggers
/// automatic synchronization of queued offline data when connectivity
/// is restored. Uses debouncing to prevent rapid state flapping.
///
/// Usage:
/// ```dart
/// final monitor = TransportConnectivityMonitor();
/// monitor.offlineSyncService = mySyncService;
/// await monitor.initialize();
///
/// monitor.connectionStream.listen((state) {
///   print('Connection state: $state');
/// });
/// ```
class TransportConnectivityMonitor {
  final Connectivity _connectivity;
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  final StreamController<ConnectionState> _connectionController =
      StreamController<ConnectionState>.broadcast();

  /// Stream of connection state changes.
  ///
  /// Emits [ConnectionState.online] when the device gains connectivity
  /// and [ConnectionState.offline] when connectivity is lost.
  Stream<ConnectionState> get connectionStream => _connectionController.stream;

  ConnectionState _currentState = ConnectionState.online;
  bool _wasOffline = false;
  bool _isSyncing = false;

  /// Current connectivity state.
  ConnectionState get currentState => _currentState;

  /// Whether the device currently has network connectivity.
  bool get isOnline => _currentState == ConnectionState.online;

  /// Whether the device is currently offline.
  bool get isOffline => _currentState == ConnectionState.offline;

  /// Reference to the OfflineSyncService for triggering sync on reconnection.
  OfflineSyncService? offlineSyncService;

  /// Timer for debouncing rapid connectivity changes.
  Timer? _debounceTimer;

  /// Debounce duration to prevent rapid state flapping.
  static const Duration debounceDuration = Duration(milliseconds: 800);

  /// Create a new connectivity monitor.
  ///
  /// Accepts an optional [Connectivity] instance for testing/injection.
  TransportConnectivityMonitor({Connectivity? connectivity})
      : _connectivity = connectivity ?? Connectivity();

  /// Initialize the monitor and start listening for connectivity changes.
  ///
  /// Checks the initial connectivity state and begins monitoring.
  Future<void> initialize() async {
    await _checkInitialConnectivity();
    _startListening();
  }

  /// Check initial connectivity state on startup.
  Future<void> _checkInitialConnectivity() async {
    try {
      final results = await _connectivity.checkConnectivity();
      final hasConnection = _hasActiveConnection(results);
      _currentState =
          hasConnection ? ConnectionState.online : ConnectionState.offline;
      _wasOffline = !hasConnection;
      _connectionController.add(_currentState);
    } catch (e) {
      // Default to offline if we can't determine connectivity
      _currentState = ConnectionState.offline;
      _wasOffline = true;
      _connectionController.add(_currentState);
    }
  }

  /// Start listening for connectivity changes from the platform.
  void _startListening() {
    _subscription = _connectivity.onConnectivityChanged.listen(
      (List<ConnectivityResult> results) {
        _debounceTimer?.cancel();
        _debounceTimer = Timer(debounceDuration, () {
          _handleConnectivityChange(results);
        });
      },
      onError: (error) {
        // On error, assume offline
        _updateState(ConnectionState.offline);
        _wasOffline = true;
      },
    );
  }

  /// Handle a connectivity change event after debouncing.
  void _handleConnectivityChange(List<ConnectivityResult> results) {
    final hasConnection = _hasActiveConnection(results);

    if (hasConnection) {
      if (_wasOffline) {
        // Transitioning from offline to online — trigger sync
        _wasOffline = false;
        _updateState(ConnectionState.online);
        _triggerSync();
      } else {
        _updateState(ConnectionState.online);
      }
    } else {
      _wasOffline = true;
      _updateState(ConnectionState.offline);
    }
  }

  /// Determine if any of the connectivity results indicate an active connection.
  bool _hasActiveConnection(List<ConnectivityResult> results) {
    if (results.isEmpty) return false;
    return results.any((result) => result != ConnectivityResult.none);
  }

  /// Trigger synchronization of all queued offline data.
  ///
  /// Called automatically when transitioning from offline to online.
  /// Guards against concurrent sync attempts.
  Future<void> _triggerSync() async {
    if (_isSyncing) return;
    if (offlineSyncService == null) return;

    _isSyncing = true;
    try {
      await offlineSyncService!.syncAll();
    } catch (e) {
      // Sync errors are handled within OfflineSyncService.
      // We just ensure the flag is reset.
    } finally {
      _isSyncing = false;
    }
  }

  /// Manually check current connectivity status.
  ///
  /// Returns `true` if the device has connectivity.
  Future<bool> checkConnectivity() async {
    try {
      final results = await _connectivity.checkConnectivity();
      final hasConnection = _hasActiveConnection(results);
      final newState =
          hasConnection ? ConnectionState.online : ConnectionState.offline;

      if (!hasConnection) {
        _wasOffline = true;
      }

      _updateState(newState);
      return hasConnection;
    } catch (e) {
      _updateState(ConnectionState.offline);
      _wasOffline = true;
      return false;
    }
  }

  /// Force a sync attempt (useful when user explicitly requests sync).
  ///
  /// Returns `true` if sync was triggered, `false` if offline or already syncing.
  Future<bool> forceSyncIfOnline() async {
    if (isOffline || _isSyncing || offlineSyncService == null) return false;

    _isSyncing = true;
    try {
      await offlineSyncService!.syncAll();
      return true;
    } catch (e) {
      return false;
    } finally {
      _isSyncing = false;
    }
  }

  void _updateState(ConnectionState newState) {
    if (newState != _currentState) {
      _currentState = newState;
      _connectionController.add(newState);
    }
  }

  /// Clean up resources. Must be called when the monitor is no longer needed.
  void dispose() {
    _debounceTimer?.cancel();
    _subscription?.cancel();
    _connectionController.close();
  }
}
