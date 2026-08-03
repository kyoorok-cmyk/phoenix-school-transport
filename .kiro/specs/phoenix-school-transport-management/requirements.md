# Requirements Document

## Introduction

Phoenix School Transport Management is a multi-tenant SaaS platform for South African school transport operators. The system enables transport companies to manage school bus routes, track vehicles in real-time, assign drivers, handle student pickups and drop-offs, notify parents, and manage billing. The platform follows the Phoenix suite architecture with a Supabase backend, Electron desktop app (for operators), Flutter mobile app (for drivers), and Preact admin portal (for vendor/platform administration).

## Glossary

- **Transport_System**: The Phoenix School Transport Management platform as a whole
- **Operator_Portal**: The Electron desktop application used by transport company staff to manage routes, vehicles, drivers, and billing
- **Driver_App**: The Flutter mobile application used by drivers for navigation, attendance tracking, and real-time communication
- **Admin_Portal**: The Preact web application used by platform vendor administrators for tenant management
- **Tenant**: A transport company or school that subscribes to the platform
- **Operator**: A transport company staff member who manages routes, schedules, and drivers
- **Driver**: A person assigned to operate a vehicle on a specific route
- **Guardian**: A parent or legal guardian of a student using the transport service
- **Student**: A learner registered for school transport services
- **Route**: A defined path with an ordered sequence of stops for student pickup and drop-off
- **Trip**: A single execution of a route at a scheduled time (morning or afternoon)
- **Stop**: A geographic location on a route where students are picked up or dropped off
- **Vehicle**: A registered transport vehicle (bus, minibus, or sedan) assigned to routes
- **Attendance_Record**: A log entry confirming a student boarded or alighted the vehicle
- **Geofence**: A virtual geographic boundary around a stop used to trigger arrival events
- **Notification_Service**: The subsystem responsible for sending alerts to guardians and operators
- **WhatsApp_Gateway**: The integration service that sends and receives WhatsApp messages via the WhatsApp Business API

## Requirements

### Requirement 1: Tenant Provisioning

**User Story:** As a platform vendor, I want to onboard new transport companies as tenants, so that each company has isolated access to manage their own operations.

#### Acceptance Criteria

1. WHEN a new tenant registration is submitted, THE Transport_System SHALL create an isolated tenant workspace with a unique tenant identifier
2. WHEN a tenant is provisioned, THE Transport_System SHALL create an administrator user account for the tenant using the Supabase Admin API
3. THE Transport_System SHALL enforce tenant data isolation through Row-Level Security policies on all database tables
4. IF tenant provisioning fails at any step, THEN THE Transport_System SHALL roll back all partially created resources and return a descriptive error message

### Requirement 2: User and Role Management

**User Story:** As a transport company operator, I want to manage staff accounts with different access levels, so that drivers only see what they need and operators have full control.

#### Acceptance Criteria

1. THE Transport_System SHALL support the following roles: operator, driver, and admin
2. WHEN an operator creates a new user, THE Transport_System SHALL create the account via the Supabase Admin API with the assigned role stored in user metadata
3. WHILE a user is authenticated, THE Operator_Portal SHALL display functionality appropriate to the user role
4. WHEN a user account is deactivated, THE Transport_System SHALL revoke all active sessions for that user within 60 seconds
5. IF a user attempts to access a resource outside their role permissions, THEN THE Transport_System SHALL deny access and log the attempt in the audit log

### Requirement 3: Vehicle Management

**User Story:** As a transport company operator, I want to register and manage vehicles in the fleet, so that I can assign them to routes and track their status.

#### Acceptance Criteria

1. WHEN an operator registers a vehicle, THE Operator_Portal SHALL store the vehicle registration number, make, model, year, seating capacity, and compliance certificate expiry date
2. THE Operator_Portal SHALL display a list of all vehicles with their current assignment status and compliance status
3. WHEN a vehicle compliance certificate is within 30 days of expiry, THE Notification_Service SHALL alert the operator
4. IF a vehicle compliance certificate has expired, THEN THE Transport_System SHALL prevent that vehicle from being assigned to active routes
5. WHILE a vehicle is assigned to an active trip, THE Transport_System SHALL prevent deletion of that vehicle record

### Requirement 4: Route Management

**User Story:** As a transport company operator, I want to create and manage transport routes with defined stops, so that drivers know where to pick up and drop off students.

#### Acceptance Criteria

1. WHEN an operator creates a route, THE Operator_Portal SHALL require a route name, associated school, list of ordered stops with GPS coordinates, and estimated travel time
2. THE Operator_Portal SHALL allow operators to reorder stops within a route using drag-and-drop interaction
3. WHEN a stop is added to a route, THE Operator_Portal SHALL store the stop name, GPS latitude, GPS longitude, and geofence radius in meters
4. THE Operator_Portal SHALL display routes on an interactive map showing all stops in sequence
5. WHEN a route is modified, THE Transport_System SHALL notify all assigned drivers of the route change via push notification

### Requirement 5: Schedule and Trip Management

**User Story:** As a transport company operator, I want to create recurring schedules for routes, so that trips run automatically on school days.

#### Acceptance Criteria

1. WHEN an operator creates a schedule, THE Operator_Portal SHALL allow selection of route, assigned vehicle, assigned driver, trip type (morning pickup or afternoon drop-off), departure time, and active weekdays
2. THE Transport_System SHALL automatically generate trip instances from active schedules for each applicable school day
3. WHEN a public holiday or school closure is recorded, THE Transport_System SHALL skip trip generation for that date
4. WHILE a schedule is active, THE Transport_System SHALL generate trips at least 7 days in advance
5. WHEN an operator cancels a scheduled trip, THE Notification_Service SHALL notify all affected guardians within 5 minutes of cancellation

### Requirement 6: Driver Trip Execution

**User Story:** As a driver, I want to view my assigned trips and record student attendance at each stop, so that parents know their children are safely on board.

#### Acceptance Criteria

1. WHEN a driver opens the Driver_App, THE Driver_App SHALL display the list of trips assigned for the current day in chronological order
2. WHEN a driver starts a trip, THE Driver_App SHALL begin transmitting the vehicle GPS location to the Transport_System every 10 seconds
3. WHEN the vehicle enters a stop geofence, THE Driver_App SHALL display the list of students assigned to that stop for attendance marking
4. WHEN a driver marks a student as boarded, THE Transport_System SHALL create an Attendance_Record with timestamp and GPS coordinates
5. WHEN a driver marks a student as absent, THE Transport_System SHALL create an Attendance_Record with absent status and notify the student Guardian
6. WHEN a driver completes all stops on a trip, THE Driver_App SHALL prompt the driver to end the trip and stop GPS transmission
7. IF the Driver_App loses GPS signal for more than 60 seconds, THEN THE Driver_App SHALL display a warning to the driver and log the GPS gap

### Requirement 7: Real-Time Vehicle Tracking

**User Story:** As a transport company operator, I want to see vehicle locations in real-time on a map, so that I can monitor fleet operations and respond to delays.

#### Acceptance Criteria

1. WHILE a trip is in progress, THE Operator_Portal SHALL display the vehicle location on a live map updated every 10 seconds
2. WHILE a trip is in progress, THE Operator_Portal SHALL display the vehicle estimated time of arrival at the next stop
3. WHEN a vehicle deviates more than 500 meters from the planned route, THE Notification_Service SHALL alert the operator
4. IF a vehicle has not reported location for more than 120 seconds during an active trip, THEN THE Operator_Portal SHALL display a "signal lost" indicator for that vehicle

### Requirement 8: Guardian Notifications

**User Story:** As a parent or guardian, I want to receive notifications about my child's transport status, so that I know when the bus is approaching and when my child boards or exits.

#### Acceptance Criteria

1. WHEN a vehicle is within 5 minutes estimated arrival of a student stop, THE Notification_Service SHALL send an approaching notification to the student Guardian
2. WHEN a student is marked as boarded, THE Notification_Service SHALL send a boarding confirmation to the student Guardian
3. WHEN a student is marked as dropped off at the school or home stop, THE Notification_Service SHALL send a drop-off confirmation to the student Guardian
4. WHEN a trip is delayed by more than 10 minutes from the scheduled time, THE Notification_Service SHALL send a delay notification to all affected Guardians with the updated estimated arrival time
5. THE Notification_Service SHALL support SMS, push notification, and WhatsApp delivery channels
6. WHERE a guardian has configured a preferred notification channel, THE Notification_Service SHALL use the preferred channel for all communications
7. WHEN a notification is sent via WhatsApp, THE WhatsApp_Gateway SHALL use pre-approved message templates compliant with WhatsApp Business API policies

### Requirement 9: Student Management

**User Story:** As a transport company operator, I want to register students and assign them to routes and stops, so that drivers know who to expect at each stop.

#### Acceptance Criteria

1. WHEN an operator registers a student, THE Operator_Portal SHALL store the student full name, grade, school, assigned route, assigned stop, and at least one guardian contact
2. THE Operator_Portal SHALL allow assigning multiple guardians to a single student
3. WHEN a student is assigned to a stop, THE Transport_System SHALL validate that the stop belongs to the student assigned route
4. THE Transport_System SHALL enforce that the total number of students assigned to a route does not exceed the assigned vehicle seating capacity
5. WHEN a student is removed from a route, THE Transport_System SHALL notify the student Guardian of the change

### Requirement 10: Billing and Invoicing

**User Story:** As a transport company operator, I want to generate monthly invoices for guardians, so that I can track payments for transport services.

#### Acceptance Criteria

1. WHEN a billing cycle ends, THE Transport_System SHALL generate an invoice for each active student based on the transport fee associated with their route
2. THE Operator_Portal SHALL allow operators to define transport fees per route on a monthly basis
3. WHEN an invoice is generated, THE Transport_System SHALL send the invoice to the guardian via the configured notification channel
4. WHEN a payment is recorded against an invoice, THE Transport_System SHALL update the invoice status and generate a receipt
5. WHEN an invoice is overdue by more than 14 days, THE Notification_Service SHALL send a payment reminder to the Guardian
6. IF an invoice is overdue by more than 30 days, THEN THE Transport_System SHALL flag the student account and notify the operator

### Requirement 11: Reporting and Analytics

**User Story:** As a transport company operator, I want to view reports on trip completion, attendance, and revenue, so that I can make informed operational decisions.

#### Acceptance Criteria

1. THE Operator_Portal SHALL provide a daily trip summary report showing completed trips, cancelled trips, and average delay time
2. THE Operator_Portal SHALL provide a monthly attendance report showing attendance rate per route and per student
3. THE Operator_Portal SHALL provide a monthly revenue report showing invoiced amounts, collected amounts, and outstanding balances per route
4. WHEN an operator requests a report, THE Operator_Portal SHALL allow export in CSV and PDF formats
5. THE Operator_Portal SHALL display a dashboard with key metrics including active students count, active routes count, fleet utilisation percentage, and monthly revenue

### Requirement 12: Offline Support for Driver App

**User Story:** As a driver, I want the app to function when I lose connectivity, so that I can continue recording attendance and the data syncs when I reconnect.

#### Acceptance Criteria

1. WHILE the Driver_App is offline, THE Driver_App SHALL allow the driver to mark student attendance and store records locally in SQLite
2. WHEN network connectivity is restored, THE Driver_App SHALL synchronize all locally stored attendance records to the Transport_System using a FIFO queue
3. WHILE the Driver_App is offline, THE Driver_App SHALL display cached trip and student data from the last successful sync
4. IF a sync conflict occurs between local and server data, THEN THE Transport_System SHALL resolve the conflict using a last-write-wins strategy with timestamp comparison
5. WHILE the Driver_App is offline, THE Driver_App SHALL queue GPS location data and transmit the full track upon reconnection

### Requirement 13: Platform Administration

**User Story:** As a platform vendor administrator, I want to manage tenant subscriptions and monitor platform health, so that I can ensure service continuity.

#### Acceptance Criteria

1. THE Admin_Portal SHALL display a list of all tenants with their subscription status, active vehicle count, and active student count
2. WHEN a vendor administrator selects a tenant, THE Admin_Portal SHALL display tenant details including subscription tier, billing history, and usage metrics
3. WHEN a vendor administrator suspends a tenant, THE Transport_System SHALL prevent all users of that tenant from accessing the system
4. THE Admin_Portal SHALL enforce vendor administrator access using a vendor_admin role verified through Row-Level Security policies
5. WHEN a tenant subscription payment fails, THE Notification_Service SHALL notify the tenant administrator and the vendor administrator

### Requirement 14: Audit and Compliance

**User Story:** As a transport company operator, I want all significant actions to be logged, so that I have a verifiable record for compliance and dispute resolution.

#### Acceptance Criteria

1. THE Transport_System SHALL log all user authentication events including successful logins, failed login attempts, and logouts
2. THE Transport_System SHALL log all data modification events including create, update, and delete operations with the performing user identifier and timestamp
3. THE Transport_System SHALL log all trip lifecycle events including start, stop arrival, attendance marking, and trip completion
4. WHEN an operator queries the audit log, THE Operator_Portal SHALL allow filtering by date range, user, event type, and entity
5. THE Transport_System SHALL retain audit log records for a minimum of 365 days

### Requirement 15: WhatsApp Integration

**User Story:** As a transport company operator, I want to communicate with guardians via WhatsApp, so that I reach them on their most-used messaging platform with trip updates and payment reminders.

#### Acceptance Criteria

1. THE WhatsApp_Gateway SHALL integrate with the WhatsApp Business API to send and receive messages
2. WHEN a guardian registers, THE Transport_System SHALL allow the operator to capture and verify the guardian WhatsApp number
3. WHEN a trip-related notification is triggered, THE WhatsApp_Gateway SHALL deliver the message using a pre-approved template with dynamic parameters (student name, route name, estimated arrival time)
4. WHEN an invoice is generated, THE WhatsApp_Gateway SHALL send the invoice summary and payment link to the guardian WhatsApp number
5. WHEN a guardian replies to a WhatsApp message, THE WhatsApp_Gateway SHALL route the reply to the operator for manual response via the Operator_Portal
6. IF the WhatsApp_Gateway fails to deliver a message after 3 retry attempts, THEN THE Notification_Service SHALL fall back to SMS delivery and log the failure
7. THE WhatsApp_Gateway SHALL log all sent and received messages in the communication log with delivery status and timestamp

