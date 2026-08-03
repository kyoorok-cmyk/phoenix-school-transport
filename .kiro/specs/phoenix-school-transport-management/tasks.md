# Implementation Plan: Phoenix School Transport Management

## Overview

This plan implements the Phoenix School Transport Management module as an extension of the existing multi-tenant SaaS platform. Implementation proceeds in logical phases: database schema and RLS policies first, then core Edge Functions, followed by Operator Portal modules, Driver App modules, notification services, and finally billing/reporting. Property-based tests validate correctness properties throughout.

## Tasks

- [x] 1. Database schema and RLS setup
  - [x] 1.1 Create transport database migration with all 14 tables
    - Create SQL migration file with all transport tables: `transport_vehicles`, `transport_routes`, `transport_stops`, `transport_students`, `transport_guardians`, `transport_student_guardians`, `transport_schedules`, `transport_trips`, `transport_attendance`, `transport_trip_locations`, `transport_invoices`, `transport_payments`, `transport_notifications`, `transport_whatsapp_messages`, `transport_school_closures`, `transport_audit_log`
    - Include all CHECK constraints, UNIQUE constraints, and indexes as defined in the design
    - _Requirements: 1.1, 3.1, 4.3, 5.1, 6.4, 9.1, 10.1, 14.2_

  - [x] 1.2 Create Row-Level Security policies for all transport tables
    - Apply `tenant_isolation` policy on all transport tables using `auth.jwt() -> 'user_metadata' ->> 'tenant_id'`
    - Create `driver_own_trips` policy on `transport_trips` allowing drivers to see only their assigned trips
    - Create policies restricting write access based on role (`operator`, `driver`, `admin`)
    - _Requirements: 1.3, 2.5, 13.4_

  - [x]* 1.3 Write property tests for tenant data isolation (Property 1)
    - **Property 1: Tenant Data Isolation**
    - Verify queries with tenant A credentials return zero rows belonging to tenant B
    - **Validates: Requirements 1.3**

  - [x]* 1.4 Write property test for role-based access denial (Property 3)
    - **Property 3: Role-Based Access Denial**
    - Verify that a user with a restricted role cannot access resources of a higher-privilege role, and an audit entry is created
    - **Validates: Requirements 2.5**

- [x] 2. Tenant provisioning and user management Edge Functions
  - [x] 2.1 Implement `provision-transport-tenant` Edge Function
    - Create the function with transaction-wrapped tenant creation (workspace, admin user, default settings)
    - On failure at any step, roll back all partially created resources and return descriptive error
    - Log provisioning events to `transport_audit_log`
    - _Requirements: 1.1, 1.2, 1.4_

  - [x]* 2.2 Write property test for provisioning atomicity (Property 2)
    - **Property 2: Tenant Provisioning Atomicity**
    - Verify that a failed provisioning leaves no partial records in the database
    - **Validates: Requirements 1.4**

  - [x] 2.3 Implement user and role management in existing auth flow
    - Extend Supabase Admin API calls to support `operator` and `driver` roles in user metadata
    - Implement session revocation for deactivated users (within 60 seconds)
    - Log all authentication events (login, failed login, logout) to `transport_audit_log`
    - _Requirements: 2.1, 2.2, 2.4, 14.1_

  - [x]* 2.4 Write property test for suspended tenant access denial (Property 27)
    - **Property 27: Suspended Tenant Access Denial**
    - Verify that all API requests from a suspended tenant's users return 403 Forbidden
    - **Validates: Requirements 13.3**

- [x] 3. Checkpoint - Database and auth foundation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Vehicle management
  - [x] 4.1 Implement `manage-vehicles` Edge Function
    - CRUD operations for vehicles with validation (registration number uniqueness per tenant, year range, seating capacity)
    - Block assignment of vehicles with expired compliance certificates
    - Block deletion of vehicles assigned to in-progress trips
    - Log all vehicle modifications to `transport_audit_log`
    - _Requirements: 3.1, 3.4, 3.5, 14.2_

  - [x]* 4.2 Write property test for vehicle compliance blocks assignment (Property 4)
    - **Property 4: Vehicle Compliance Blocks Assignment**
    - Verify that a vehicle with expired compliance certificate cannot be assigned to active routes
    - **Validates: Requirements 3.4**

  - [x]* 4.3 Write property test for vehicle deletion protection (Property 5)
    - **Property 5: Vehicle Deletion Protection During Active Trip**
    - Verify deletion is rejected when vehicle is assigned to an in-progress trip
    - **Validates: Requirements 3.5**

  - [x] 4.4 Implement compliance expiry monitoring
    - Create a scheduled check (or trigger) for vehicles within 30 days of compliance expiry
    - Generate operator alert notifications for expiring vehicles
    - _Requirements: 3.3_

  - [x]* 4.5 Write property test for compliance expiry notification threshold (Property 6)
    - **Property 6: Compliance Expiry Notification Threshold**
    - Verify alerts fire for vehicles with expiry within 30 days, and not for those beyond 30 days
    - **Validates: Requirements 3.3**

- [x] 5. Route and stop management
  - [x] 5.1 Implement `manage-routes` Edge Function
    - CRUD for routes with validation (route name, school, estimated travel time, monthly fee)
    - CRUD for stops within a route (stop name, lat/lng, geofence radius, stop_order)
    - Reordering support for stops
    - On route modification, trigger push notification to all assigned drivers
    - Log all route modifications to `transport_audit_log`
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 14.2_

  - [x]* 5.2 Write property test for route modification notifies all drivers (Property 7)
    - **Property 7: Route Modification Notifies All Assigned Drivers**
    - Verify that modifying a route produces exactly N notifications for N assigned drivers
    - **Validates: Requirements 4.5**

  - [x] 5.3 Implement `manage-students` Edge Function
    - CRUD for students with guardian contact requirement
    - Validate stop-route consistency (assigned stop must belong to assigned route)
    - Enforce vehicle capacity (students on route ≤ vehicle seating capacity)
    - Notify guardians when student removed from route
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x]* 5.4 Write property test for student registration requires guardian (Property 16)
    - **Property 16: Student Registration Requires Guardian**
    - Verify rejection of student registration without at least one guardian contact
    - **Validates: Requirements 9.1**

  - [x]* 5.5 Write property test for student-stop route consistency (Property 17)
    - **Property 17: Student-Stop Route Consistency**
    - Verify that assigning a stop not on the student's route is rejected
    - **Validates: Requirements 9.3**

  - [x]* 5.6 Write property test for vehicle capacity enforcement (Property 18)
    - **Property 18: Vehicle Capacity Enforcement**
    - Verify that student assignments exceeding vehicle capacity are rejected
    - **Validates: Requirements 9.4**

- [x] 6. Checkpoint - Core entities ready
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Schedule and trip management
  - [x] 7.1 Implement `manage-schedules` Edge Function
    - CRUD for schedules (route, vehicle, driver, trip type, departure time, active days)
    - Trip generation algorithm: generate trips for active schedules on matching weekdays, skipping school closures
    - Generate trips at least 7 days in advance
    - On trip cancellation, notify affected guardians within 5 minutes
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 7.2 Write property test for trip generation correctness (Property 8)
    - **Property 8: Trip Generation Correctness**
    - Verify trips are generated only on matching active_days that are not closure dates
    - **Validates: Requirements 5.2, 5.3**

  - [x]* 7.3 Write property test for trip generation lookahead (Property 9)
    - **Property 9: Trip Generation Lookahead**
    - Verify that trip instances cover at least 7 days into the future
    - **Validates: Requirements 5.4**

- [x] 8. Driver trip execution
  - [x] 8.1 Implement `start-trip` and `end-trip` Edge Functions
    - `start-trip`: Mark trip as in_progress, record actual_departure timestamp
    - `end-trip`: Mark trip as completed, record actual_completion timestamp, stop GPS tracking
    - Log trip lifecycle events to `transport_audit_log`
    - _Requirements: 6.2, 6.6, 14.3_

  - [x] 8.2 Implement `record-attendance` Edge Function
    - Create attendance records with status (boarded/absent/dropped_off), timestamp, and GPS coordinates
    - On absent marking, trigger guardian notification
    - On boarded/dropped_off marking, trigger guardian notification
    - _Requirements: 6.4, 6.5, 8.2, 8.3_

  - [x]* 8.3 Write property test for driver trip list ordering (Property 10)
    - **Property 10: Driver Trip List Ordering**
    - Verify trips for a driver on a given date are sorted by scheduled_departure ascending
    - **Validates: Requirements 6.1**

- [x] 9. GPS tracking and geofence detection
  - [x] 9.1 Implement `check-geofence` Edge Function
    - Calculate haversine distance between vehicle GPS position and each stop on the active route
    - Determine geofence entry when distance ≤ stop's geofence_radius_meters
    - Trigger approaching notification when ETA ≤ 5 minutes
    - Detect route deviation when minimum distance to route exceeds 500 meters
    - _Requirements: 6.3, 7.3, 8.1_

  - [x] 9.2 Implement GPS location storage and Realtime channel broadcasting
    - Store GPS locations in `transport_trip_locations` table
    - Publish to `trip:{trip_id}:location` Realtime channel every 10 seconds
    - Detect signal loss > 120 seconds and alert operator via `tenant:{tenant_id}:alerts` channel
    - _Requirements: 6.2, 7.1, 7.4_

  - [x]* 9.3 Write property test for geofence detection correctness (Property 11)
    - **Property 11: Geofence Detection Correctness**
    - Verify vehicle is within geofence iff haversine distance ≤ R meters
    - **Validates: Requirements 6.3**

  - [x]* 9.4 Write property test for route deviation detection (Property 12)
    - **Property 12: Route Deviation Detection**
    - Verify deviation alert triggers when vehicle > 500m from planned route
    - **Validates: Requirements 7.3**

  - [x]* 9.5 Write property test for ETA-based approaching notification (Property 13)
    - **Property 13: ETA-Based Approaching Notification**
    - Verify approaching notification triggers for all guardians of students at a stop when ETA ≤ 5 minutes
    - **Validates: Requirements 8.1**

  - [x]* 9.6 Write property test for delay notification trigger (Property 14)
    - **Property 14: Delay Notification Trigger**
    - Verify delay notification is sent when actual departure exceeds scheduled by > 10 minutes
    - **Validates: Requirements 8.4**

- [x] 10. Checkpoint - Trip execution and tracking ready
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Notification service and WhatsApp integration
  - [x] 11.1 Implement `send-notification` Edge Function
    - Route notifications via preferred guardian channel (sms, push, whatsapp)
    - Implement retry logic: up to 3 attempts with exponential backoff (2s, 4s, 8s)
    - Implement fallback chain: WhatsApp → SMS → Push
    - Log all attempts to `transport_notifications` with retry_count and fallback_used
    - _Requirements: 8.5, 8.6, 8.7_

  - [x] 11.2 Implement `whatsapp-send` and `whatsapp-webhook` Edge Functions
    - `whatsapp-send`: Send outbound template messages via WhatsApp Business API with dynamic parameters
    - `whatsapp-webhook`: Receive inbound messages, route to operator, log to `transport_whatsapp_messages`
    - Log all sent/received messages with direction, delivery_status, and timestamp
    - _Requirements: 15.1, 15.3, 15.4, 15.5, 15.7_

  - [x]* 11.3 Write property test for guardian preferred channel routing (Property 15)
    - **Property 15: Guardian Preferred Channel Routing**
    - Verify notifications use the guardian's preferred channel unless fallback triggered
    - **Validates: Requirements 8.6**

  - [x]* 11.4 Write property test for WhatsApp template parameter population (Property 29)
    - **Property 29: WhatsApp Template Parameter Population**
    - Verify trip-related WhatsApp messages contain all required parameters (student_name, route_name, eta)
    - **Validates: Requirements 15.3**

  - [x]* 11.5 Write property test for WhatsApp fallback to SMS after 3 failures (Property 30)
    - **Property 30: WhatsApp Fallback to SMS After 3 Failures**
    - Verify SMS fallback occurs after 3 WhatsApp failures, with proper logging
    - **Validates: Requirements 15.6**

  - [x]* 11.6 Write property test for WhatsApp message logging (Property 31)
    - **Property 31: WhatsApp Message Logging**
    - Verify all sent/received WhatsApp messages are logged with correct direction and status
    - **Validates: Requirements 15.7**

- [x] 12. Offline sync support (Driver App)
  - [x] 12.1 Implement `sync-offline-data` Edge Function
    - Accept batched attendance records and GPS locations from offline queue
    - Process in FIFO order by recorded_at timestamp
    - Wrap each sync batch in a transaction (partial failure rolls back batch)
    - Resolve conflicts using last-write-wins by timestamp comparison
    - Mark synced records with `synced_from_offline = true`
    - _Requirements: 12.1, 12.2, 12.4_

  - [x]* 12.2 Write property test for offline sync FIFO order (Property 25)
    - **Property 25: Offline Sync FIFO Order**
    - Verify queued records with timestamps t1 < t2 < ... < tN are transmitted in order
    - **Validates: Requirements 12.2**

  - [x]* 12.3 Write property test for conflict resolution last-write-wins (Property 26)
    - **Property 26: Conflict Resolution Last-Write-Wins**
    - Verify the record with the later timestamp wins when local and server conflict
    - **Validates: Requirements 12.4**

- [x] 13. Billing and invoicing
  - [x] 13.1 Implement `generate-invoice` Edge Function
    - Generate monthly invoices for each active student based on route monthly_fee
    - Set due_date and status to 'pending'
    - Send invoice to guardian via configured notification channel (including WhatsApp with payment link)
    - _Requirements: 10.1, 10.2, 10.3, 15.4_

  - [x] 13.2 Implement `record-payment` Edge Function
    - Record payment against invoice with method, amount, reference
    - Update invoice status to 'paid' when payment total ≥ invoice amount
    - Generate receipt
    - _Requirements: 10.4_

  - [x] 13.3 Implement overdue invoice monitoring
    - Send payment reminder at 14 days overdue
    - Flag student account and notify operator at 30 days overdue
    - _Requirements: 10.5, 10.6_

  - [x]* 13.4 Write property test for invoice amount matches route fee (Property 19)
    - **Property 19: Invoice Amount Matches Route Fee**
    - Verify generated invoice amount equals the student's route monthly_fee
    - **Validates: Requirements 10.1**

  - [x]* 13.5 Write property test for payment updates invoice status (Property 20)
    - **Property 20: Payment Updates Invoice Status**
    - Verify invoice transitions to 'paid' when payment total ≥ invoice amount
    - **Validates: Requirements 10.4**

  - [x]* 13.6 Write property test for overdue invoice reminder at 14 days (Property 21)
    - **Property 21: Overdue Invoice Reminder at 14 Days**
    - Verify reminder sent when invoice unpaid and > 14 days past due_date
    - **Validates: Requirements 10.5**

  - [x]* 13.7 Write property test for overdue invoice flagging at 30 days (Property 22)
    - **Property 22: Overdue Invoice Flagging at 30 Days**
    - Verify student flagging and operator notification when > 30 days overdue
    - **Validates: Requirements 10.6**

- [x] 14. Checkpoint - Core backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Reporting and analytics
  - [x] 15.1 Implement `generate-transport-report` Edge Function
    - Daily trip summary: completed, cancelled, average delay
    - Monthly attendance report: rate per route and per student
    - Monthly revenue report: invoiced, collected, outstanding per route
    - Export in CSV and PDF formats
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x]* 15.2 Write property test for attendance rate calculation (Property 23)
    - **Property 23: Attendance Rate Calculation**
    - Verify attendance_rate = count(boarded) / total_expected_trips for a student in a month
    - **Validates: Requirements 11.2**

  - [x]* 15.3 Write property test for revenue report correctness (Property 24)
    - **Property 24: Revenue Report Correctness**
    - Verify invoiced_total = sum(amounts), collected_total = sum(payments), outstanding = difference
    - **Validates: Requirements 11.3**

- [x] 16. Audit logging
  - [x] 16.1 Implement comprehensive audit logging
    - Create database triggers or Edge Function middleware to log all data modification events (create, update, delete) with user_id and timestamp
    - Log all trip lifecycle events (start, stop arrival, attendance, completion)
    - Implement audit log query with filtering by date range, user, event type, entity
    - Ensure 365-day retention
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x]* 16.2 Write property test for audit log completeness (Property 28)
    - **Property 28: Audit Log Completeness**
    - Verify every significant event creates exactly one audit entry with required fields
    - **Validates: Requirements 14.1, 14.2, 14.3**

- [x] 17. Operator Portal modules (Electron)
  - [x] 17.1 Implement VehicleManager module
    - Fleet list with assignment status and compliance status display
    - Vehicle CRUD forms with validation
    - Compliance expiry highlighting (within 30 days → warning, expired → error)
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 17.2 Implement RouteEditor module with interactive map
    - Route CRUD with stop management
    - Interactive map display showing stops in sequence
    - Drag-and-drop stop reordering
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 17.3 Implement ScheduleManager module
    - Schedule CRUD forms (route, vehicle, driver, trip type, departure time, active days)
    - Trip calendar view showing generated trips
    - Trip cancellation with confirmation
    - _Requirements: 5.1, 5.5_

  - [x] 17.4 Implement StudentManager module
    - Student registration forms with guardian contact
    - Route and stop assignment with validation feedback
    - Multiple guardian support
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 17.5 Implement LiveTrackingMap module
    - Real-time vehicle positions on map updated every 10 seconds via Realtime subscription
    - ETA display for next stop
    - Signal lost indicator for vehicles not reporting > 120 seconds
    - Route deviation alerts
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 17.6 Implement BillingModule
    - Fee configuration per route
    - Invoice generation trigger
    - Payment recording forms
    - Invoice status dashboard with overdue highlighting
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 17.7 Implement ReportViewer module
    - Daily trip summary report view
    - Monthly attendance report view
    - Monthly revenue report view
    - CSV and PDF export functionality
    - Dashboard with key metrics (active students, routes, fleet utilisation, revenue)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 17.8 Implement AuditLogViewer module
    - Filterable audit log display (date range, user, event type, entity)
    - _Requirements: 14.4_

- [x] 18. Checkpoint - Operator Portal complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Driver App modules (Flutter)
  - [x] 19.1 Implement TripListScreen
    - Display assigned trips for current day in chronological order
    - Show trip status (scheduled, in_progress, completed)
    - _Requirements: 6.1_

  - [x] 19.2 Implement ActiveTripScreen and AttendanceSheet
    - Start trip action triggering GPS transmission
    - Geofence-triggered student list display per stop
    - Board/absent toggle for each student
    - End trip prompt when all stops completed
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 19.3 Implement GPSService with background location tracking
    - Background GPS transmission every 10 seconds to Supabase Realtime channel
    - GPS signal loss detection (> 60 seconds) with driver warning
    - Queue GPS data when offline
    - _Requirements: 6.2, 6.7, 12.5_

  - [x] 19.4 Implement OfflineSyncService and ConnectivityMonitor
    - SQLite local storage for attendance records and GPS data
    - Connectivity detection and automatic FIFO sync on reconnection
    - Display cached trip/student data when offline
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

- [x] 20. Admin Portal (Preact)
  - [x] 20.1 Implement tenant management views
    - Tenant list with subscription status, vehicle count, student count
    - Tenant detail view with subscription tier, billing history, usage metrics
    - Tenant suspension action
    - Vendor admin role enforcement via RLS
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 21. Final checkpoint - All components integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check` with `vitest`
- Unit tests validate specific examples and edge cases
- The project uses TypeScript (Electron/Preact), Dart (Flutter), and SQL (Supabase)
- All Edge Functions run on Deno (Supabase Edge Functions runtime)
- Existing `fast-check` v3.23.2 and `vitest` v1.6.1 are already in the desktop-app devDependencies

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.1", "2.3"] },
    { "id": 3, "tasks": ["2.2", "2.4", "4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "5.2", "5.3"] },
    { "id": 5, "tasks": ["4.5", "5.4", "5.5", "5.6", "7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "8.1", "8.2"] },
    { "id": 7, "tasks": ["8.3", "9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3", "9.4", "9.5", "9.6", "11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3", "11.4", "11.5", "11.6", "12.1"] },
    { "id": 10, "tasks": ["12.2", "12.3", "13.1", "13.2", "13.3"] },
    { "id": 11, "tasks": ["13.4", "13.5", "13.6", "13.7", "15.1"] },
    { "id": 12, "tasks": ["15.2", "15.3", "16.1"] },
    { "id": 13, "tasks": ["16.2", "17.1", "17.2", "17.3", "17.4"] },
    { "id": 14, "tasks": ["17.5", "17.6", "17.7", "17.8"] },
    { "id": 15, "tasks": ["19.1", "19.2", "19.3", "19.4"] },
    { "id": 16, "tasks": ["20.1"] }
  ]
}
```
