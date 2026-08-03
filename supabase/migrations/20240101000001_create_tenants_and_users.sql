-- Foundation tables for the Phoenix School Transport platform

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT,
    physical_address TEXT,
    subscription_tier TEXT NOT NULL DEFAULT 'starter' CHECK (subscription_tier IN ('starter', 'professional', 'enterprise')),
    subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'payment_failed', 'grace_period', 'suspended', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    tier TEXT NOT NULL DEFAULT 'starter',
    status TEXT NOT NULL DEFAULT 'active',
    monthly_amount NUMERIC(10,2) DEFAULT 0,
    current_period_start TIMESTAMPTZ DEFAULT now(),
    current_period_end TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
    grace_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Safe helper functions - use current_setting with missing_ok=true to avoid errors
CREATE OR REPLACE FUNCTION public.get_tenant_id() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_val TEXT;
BEGIN
  v_val := current_setting('request.jwt.claims', true)::json -> 'user_metadata' ->> 'tenant_id';
  IF v_val IS NULL OR v_val = '' THEN RETURN NULL; END IF;
  RETURN v_val::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_val TEXT;
BEGIN
  v_val := current_setting('request.jwt.claims', true)::json -> 'user_metadata' ->> 'role';
  IF v_val IS NULL OR v_val = '' THEN RETURN NULL; END IF;
  RETURN v_val;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_new_tenant(
    p_company_name TEXT,
    p_contact_email TEXT,
    p_contact_phone TEXT DEFAULT NULL,
    p_physical_address TEXT DEFAULT NULL,
    p_tier TEXT DEFAULT 'starter'
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_tenant_id UUID;
BEGIN
    INSERT INTO tenants (name, company_name, contact_email, contact_phone, physical_address, subscription_tier)
    VALUES (p_company_name, p_company_name, p_contact_email, p_contact_phone, p_physical_address, p_tier)
    RETURNING id INTO v_tenant_id;

    INSERT INTO subscriptions (tenant_id, tier, status)
    VALUES (v_tenant_id, p_tier, 'active');

    RETURN v_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.provision_new_tenant TO service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_id TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role TO authenticated, anon, service_role;
