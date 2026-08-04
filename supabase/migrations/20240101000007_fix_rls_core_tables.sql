-- Fix: Enable RLS on core tables that were missing it
-- Tables: tenants, subscriptions, schools

-- =============================================================================
-- ENABLE RLS
-- =============================================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'schools' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE schools ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'parent_contracts' AND schemaname = 'public') THEN
    EXECUTE 'ALTER TABLE parent_contracts ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- =============================================================================
-- POLICIES
-- =============================================================================

-- Tenants: users can read their own tenant
CREATE POLICY tenants_read_own ON tenants
    FOR SELECT USING (id = public.get_tenant_id());

-- Tenants: service role full access (for provisioning)
CREATE POLICY tenants_service_all ON tenants
    FOR ALL USING (auth.role() = 'service_role');

-- Subscriptions: tenant isolation
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
    FOR ALL USING (tenant_id = public.get_tenant_id());

-- Subscriptions: service role full access
CREATE POLICY subscriptions_service_all ON subscriptions
    FOR ALL USING (auth.role() = 'service_role');

-- Schools: tenant isolation (if table exists)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'schools' AND schemaname = 'public') THEN
    IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'schools' AND policyname = 'schools_tenant_isolation') THEN
      EXECUTE 'CREATE POLICY schools_tenant_isolation ON schools FOR ALL USING (tenant_id = public.get_tenant_id())';
    END IF;
  END IF;
END $$;

-- Parent contracts: tenant isolation (if table exists)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'parent_contracts' AND schemaname = 'public') THEN
    IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = 'parent_contracts' AND policyname = 'parent_contracts_tenant_isolation') THEN
      EXECUTE 'CREATE POLICY parent_contracts_tenant_isolation ON parent_contracts FOR ALL USING (tenant_id = public.get_tenant_id())';
    END IF;
  END IF;
END $$;
