-- Migration: Create transport management tables
-- Tables: transport_vehicles, transport_routes, transport_stops, transport_students,
--         transport_guardians, transport_student_guardians, transport_schedules,
--         transport_trips, transport_attendance, transport_trip_locations,
--         transport_invoices, transport_payments, transport_notifications,
--         transport_whatsapp_messages, transport_school_closures, transport_audit_log
-- Part of: Phoenix School Transport Management

-- =============================================================================
-- VEHICLES TABLE
-- =============================================================================
CREATE TABLE transport_vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    registration_number TEXT NOT NULL,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER NOT NULL CHECK (year BETWEEN 1990 AND 2100),
    seating_capacity INTEGER NOT NULL CHECK (seating_capacity BETWEEN 1 AND 100),
    compliance_certificate_expiry DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'maintenance', 'decommissioned')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, registration_number)
);

-- =============================================================================
-- ROUTES TABLE
-- =============================================================================
CREATE TABLE transport_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    route_name TEXT NOT NULL,
    school_name TEXT NOT NULL,
    estimated_travel_minutes INTEGER NOT NULL CHECK (estimated_travel_minutes > 0),
    monthly_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- STOPS TABLE
-- =============================================================================
CREATE TABLE transport_stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    stop_name TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    geofence_radius_meters INTEGER NOT NULL DEFAULT 100 CHECK (geofence_radius_meters BETWEEN 10 AND 5000),
    stop_order INTEGER NOT NULL CHECK (stop_order > 0),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (route_id, stop_order)
);

-- =============================================================================
-- STUDENTS TABLE
-- =============================================================================
CREATE TABLE transport_students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    full_name TEXT NOT NULL,
    grade TEXT NOT NULL,
    school_name TEXT NOT NULL,
    assigned_route_id UUID REFERENCES transport_routes(id),
    assigned_stop_id UUID REFERENCES transport_stops(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- GUARDIANS TABLE
-- =============================================================================
CREATE TABLE transport_guardians (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    full_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    whatsapp_number TEXT,
    email TEXT,
    preferred_notification_channel TEXT NOT NULL DEFAULT 'sms' CHECK (preferred_notification_channel IN ('sms', 'push', 'whatsapp')),
    push_token TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- STUDENT-GUARDIAN JUNCTION TABLE
-- =============================================================================
CREATE TABLE transport_student_guardians (
    student_id UUID NOT NULL REFERENCES transport_students(id) ON DELETE CASCADE,
    guardian_id UUID NOT NULL REFERENCES transport_guardians(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT 'parent',
    is_primary BOOLEAN DEFAULT false,
    PRIMARY KEY (student_id, guardian_id)
);

-- =============================================================================
-- SCHEDULES TABLE
-- =============================================================================
CREATE TABLE transport_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    route_id UUID NOT NULL REFERENCES transport_routes(id),
    vehicle_id UUID NOT NULL REFERENCES transport_vehicles(id),
    driver_id UUID NOT NULL,
    trip_type TEXT NOT NULL CHECK (trip_type IN ('morning_pickup', 'afternoon_dropoff')),
    departure_time TIME NOT NULL,
    active_days TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- TRIPS TABLE
-- =============================================================================
CREATE TABLE transport_trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    schedule_id UUID NOT NULL REFERENCES transport_schedules(id),
    route_id UUID NOT NULL REFERENCES transport_routes(id),
    vehicle_id UUID NOT NULL REFERENCES transport_vehicles(id),
    driver_id UUID NOT NULL,
    trip_date DATE NOT NULL,
    trip_type TEXT NOT NULL CHECK (trip_type IN ('morning_pickup', 'afternoon_dropoff')),
    scheduled_departure TIME NOT NULL,
    actual_departure TIMESTAMPTZ,
    actual_completion TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (schedule_id, trip_date)
);

-- =============================================================================
-- ATTENDANCE RECORDS TABLE
-- =============================================================================
CREATE TABLE transport_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    trip_id UUID NOT NULL REFERENCES transport_trips(id),
    student_id UUID NOT NULL REFERENCES transport_students(id),
    stop_id UUID NOT NULL REFERENCES transport_stops(id),
    status TEXT NOT NULL CHECK (status IN ('boarded', 'absent', 'dropped_off')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    synced_from_offline BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (trip_id, student_id, status)
);

-- =============================================================================
-- TRIP LOCATIONS TABLE (GPS tracking history)
-- =============================================================================
CREATE TABLE transport_trip_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL REFERENCES transport_trips(id),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    speed_kmh NUMERIC(5, 1),
    heading NUMERIC(5, 1),
    synced_from_offline BOOLEAN DEFAULT false
);

-- =============================================================================
-- INVOICES TABLE
-- =============================================================================
CREATE TABLE transport_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    student_id UUID NOT NULL REFERENCES transport_students(id),
    guardian_id UUID NOT NULL REFERENCES transport_guardians(id),
    invoice_number TEXT NOT NULL,
    billing_month DATE NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
    due_date DATE NOT NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, invoice_number)
);

-- =============================================================================
-- TRANSPORT PAYMENTS TABLE
-- =============================================================================
CREATE TABLE transport_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    invoice_id UUID NOT NULL REFERENCES transport_invoices(id),
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('eft', 'cash', 'card', 'debit_order')),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- NOTIFICATIONS LOG TABLE
-- =============================================================================
CREATE TABLE transport_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    guardian_id UUID NOT NULL REFERENCES transport_guardians(id),
    notification_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('sms', 'push', 'whatsapp')),
    template_name TEXT,
    template_params JSONB,
    delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed')),
    retry_count INTEGER DEFAULT 0,
    fallback_used BOOLEAN DEFAULT false,
    external_message_id TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- WHATSAPP MESSAGES LOG
-- =============================================================================
CREATE TABLE transport_whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    phone_number TEXT NOT NULL,
    template_name TEXT,
    message_body TEXT,
    delivery_status TEXT DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    external_message_id TEXT,
    guardian_id UUID REFERENCES transport_guardians(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- SCHOOL CLOSURES / HOLIDAYS TABLE
-- =============================================================================
CREATE TABLE transport_school_closures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    closure_date DATE NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, closure_date)
);

-- =============================================================================
-- AUDIT LOG TABLE (transport-specific events)
-- =============================================================================
CREATE TABLE transport_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    details JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT now()
);


-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX idx_transport_vehicles_tenant ON transport_vehicles(tenant_id);
CREATE INDEX idx_transport_routes_tenant ON transport_routes(tenant_id);
CREATE INDEX idx_transport_stops_route ON transport_stops(route_id);
CREATE INDEX idx_transport_students_tenant ON transport_students(tenant_id);
CREATE INDEX idx_transport_students_route ON transport_students(assigned_route_id);
CREATE INDEX idx_transport_schedules_tenant ON transport_schedules(tenant_id);
CREATE INDEX idx_transport_trips_tenant_date ON transport_trips(tenant_id, trip_date);
CREATE INDEX idx_transport_trips_driver_date ON transport_trips(driver_id, trip_date);
CREATE INDEX idx_transport_trips_status ON transport_trips(status);
CREATE INDEX idx_transport_attendance_trip ON transport_attendance(trip_id);
CREATE INDEX idx_transport_attendance_student ON transport_attendance(student_id);
CREATE INDEX idx_transport_trip_locations_trip ON transport_trip_locations(trip_id);
CREATE INDEX idx_transport_trip_locations_time ON transport_trip_locations(trip_id, recorded_at);
CREATE INDEX idx_transport_invoices_tenant_month ON transport_invoices(tenant_id, billing_month);
CREATE INDEX idx_transport_invoices_guardian ON transport_invoices(guardian_id);
CREATE INDEX idx_transport_invoices_status ON transport_invoices(status);
CREATE INDEX idx_transport_notifications_guardian ON transport_notifications(guardian_id);
CREATE INDEX idx_transport_audit_tenant_time ON transport_audit_log(tenant_id, created_at);
CREATE INDEX idx_transport_audit_event ON transport_audit_log(tenant_id, event_type);
