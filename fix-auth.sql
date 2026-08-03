-- ============================================================================
-- FIX: Make RLS helper functions completely NULL-safe
-- The problem: During Supabase Auth signup/login operations, there is no JWT.
-- Our get_tenant_id() tries to cast NULL to UUID which throws an error.
-- This cascades through RLS policy evaluation and breaks auth completely.
-- ============================================================================

-- Drop existing functions first to avoid signature conflicts
DROP FUNCTION IF EXISTS public.get_tenant_id();
DROP FUNCTION IF EXISTS public.get_user_role();

-- Recreate with proper NULL handling (plpgsql with exception handler)
CREATE OR REPLACE FUNCTION public.get_tenant_id() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_tenant_id TEXT;
BEGIN
  -- auth.jwt() returns NULL when no session exists (e.g., during signup)
  v_tenant_id := current_setting('request.jwt.claims', true)::json -> 'user_metadata' ->> 'tenant_id';
  IF v_tenant_id IS NULL OR v_tenant_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_tenant_id::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN current_setting('request.jwt.claims', true)::json -> 'user_metadata' ->> 'role';
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Grant access
GRANT EXECUTE ON FUNCTION public.get_tenant_id TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_id TO anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_id TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role TO anon;
GRANT EXECUTE ON FUNCTION public.get_user_role TO service_role;
