-- Migration: Transport Auth Event Logging (safe version)
-- Simple logging function that does NOT query auth.users directly.
-- Edge Functions handle auth event logging via direct inserts.

CREATE OR REPLACE FUNCTION public.log_transport_auth_event(
    p_tenant_id UUID,
    p_user_id UUID DEFAULT NULL,
    p_event_type TEXT DEFAULT 'login',
    p_entity_id UUID DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::JSONB,
    p_ip_address TEXT DEFAULT '0.0.0.0'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_log_id UUID;
    v_ip INET;
BEGIN
    BEGIN
        v_ip := p_ip_address::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip := '0.0.0.0'::INET;
    END;

    INSERT INTO transport_audit_log (
        tenant_id, user_id, event_type, entity_type, entity_id, details, ip_address
    ) VALUES (
        p_tenant_id, p_user_id, p_event_type, 'authentication', p_entity_id, p_details, v_ip
    )
    RETURNING id INTO v_log_id;

    RETURN v_log_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_transport_auth_event TO service_role;
GRANT EXECUTE ON FUNCTION public.log_transport_auth_event TO authenticated;
