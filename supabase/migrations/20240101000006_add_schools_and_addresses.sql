-- Migration: Add transport_schools table and address fields to students/guardians
-- Part of: Phoenix School Transport - School-centric management

-- =============================================================================
-- SCHOOLS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS transport_schools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    school_name TEXT NOT NULL,
    address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    contact_phone TEXT,
    contact_email TEXT,
    principal_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_id, school_name)
);

CREATE INDEX idx_transport_schools_tenant ON transport_schools(tenant_id);

-- =============================================================================
-- ADD PICKUP/DROPOFF ADDRESS FIELDS TO STUDENTS
-- =============================================================================
ALTER TABLE transport_students ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE transport_students ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE transport_students ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE transport_students ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES transport_schools(id);

-- =============================================================================
-- ADD ADDRESS TO GUARDIANS
-- =============================================================================
ALTER TABLE transport_guardians ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE transport_guardians ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION;
ALTER TABLE transport_guardians ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION;
