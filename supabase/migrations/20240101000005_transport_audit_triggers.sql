-- Migration: Transport Audit Query Function
-- Provides filtered access to audit log. NO triggers (they caused auth issues).
-- Audit logging is handled by Edge Functions directly.

CREATE OR REPLACE FUNCTION public.query_transport_audit_log(
    p_tenant_id UUID,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_event_type TEXT DEFAULT NULL,
    p_entity_type TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    tenant_id UUID,
    user_id UUID,
    event_type TEXT,
    entity_type TEXT,
    entity_id UUID,
    details JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        tal.id, tal.tenant_id, tal.user_id, tal.event_type,
        tal.entity_type, tal.entity_id, tal.details, tal.ip_address, tal.created_at
    FROM transport_audit_log tal
    WHERE tal.tenant_id = p_tenant_id
      AND (p_date_from IS NULL OR tal.created_at >= p_date_from)
      AND (p_date_to IS NULL OR tal.created_at <= p_date_to)
      AND (p_user_id IS NULL OR tal.user_id = p_user_id)
      AND (p_event_type IS NULL OR tal.event_type = p_event_type)
      AND (p_entity_type IS NULL OR tal.entity_type = p_entity_type)
    ORDER BY tal.created_at DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.query_transport_audit_log TO service_role;
GRANT EXECUTE ON FUNCTION public.query_transport_audit_log TO authenticated;
