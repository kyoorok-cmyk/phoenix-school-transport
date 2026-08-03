import { useEffect, useState } from 'preact/hooks';
import { StatsCard } from '../components/StatsCard';
import { supabaseAdmin } from '../services/supabase-admin';

interface TenantDetailProps { id: string; }

interface TenantData {
  id: string; company_name: string; contact_email: string;
  contact_phone: string | null; subscription_tier: string;
  subscription_status: string; created_at: string;
}

export function TenantDetail({ id }: TenantDetailProps) {
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [counts, setCounts] = useState({ vehicles: 0, students: 0, routes: 0, schedules: 0 });
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => { loadAll(); }, [id]);

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const { data, error: fetchErr } = await supabaseAdmin.from('tenants').select('*').eq('id', id).single();
      if (fetchErr) throw new Error(fetchErr.message);
      setTenant(data);
      const [v, s, r, sc] = await Promise.all([
        supabaseAdmin.from('transport_vehicles').select('*', { count: 'exact', head: true }).eq('tenant_id', id),
        supabaseAdmin.from('transport_students').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'active'),
        supabaseAdmin.from('transport_routes').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('is_active', true),
        supabaseAdmin.from('transport_schedules').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('is_active', true),
      ]);
      setCounts({ vehicles: v.count || 0, students: s.count || 0, routes: r.count || 0, schedules: sc.count || 0 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load tenant details';
      setError(message);
      console.error('[TenantDetail]', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleSuspend() {
    if (!tenant) return;
    setActionError('');
    const action = tenant.subscription_status === 'suspended' ? 'active' : 'suspended';
    const msg = action === 'suspended'
      ? `Suspend "${tenant.company_name}"? All users will lose access.`
      : `Reactivate "${tenant.company_name}"?`;
    if (!confirm(msg)) return;
    setActionLoading(true);
    try {
      const { error: updateErr } = await supabaseAdmin.from('tenants').update({ subscription_status: action }).eq('id', id);
      if (updateErr) throw new Error(updateErr.message);
      await loadAll();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to update tenant status';
      setActionError(message);
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) return <div style={{ padding: '60px', textAlign: 'center', color: '#94A3B8' }}>Loading...</div>;
  if (error) return <div style={{ padding: '20px', background: '#FEF2F2', color: '#DC2626', borderRadius: '8px', border: '1px solid #FECACA' }}>⚠️ {error}</div>;
  if (!tenant) return <div style={{ padding: '20px' }}>Tenant not found.</div>;

  const isSuspended = tenant.subscription_status === 'suspended';

  return (
    <div>
      <a href="#/" style={{ color: '#8B1A2B', textDecoration: 'none', fontSize: '13px', fontWeight: 600 }}>← Back to Tenants</a>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em' }}>{tenant.company_name}</h2>
          <p style={{ fontSize: '13px', color: '#64748B', marginTop: '4px' }}>{tenant.contact_email}</p>
        </div>
        <span style={{
          padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
          background: isSuspended ? '#FEE2E2' : '#D1FAE5',
          color: isSuspended ? '#991B1B' : '#065F46',
        }}>{tenant.subscription_status}</span>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        <StatsCard title="Vehicles" value={counts.vehicles} color="#3B82F6" />
        <StatsCard title="Active Students" value={counts.students} color="#10B981" />
        <StatsCard title="Routes" value={counts.routes} color="#8B5CF6" />
        <StatsCard title="Schedules" value={counts.schedules} color="#F59E0B" />
      </div>

      {/* Details card */}
      <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #E2E8F0', padding: '24px', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '16px', color: '#1E293B' }}>Subscription Details</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
          <div><p style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase' }}>Tier</p><p style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>{tenant.subscription_tier}</p></div>
          <div><p style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase' }}>Phone</p><p style={{ fontSize: '14px', marginTop: '4px' }}>{tenant.contact_phone || 'N/A'}</p></div>
          <div><p style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase' }}>Created</p><p style={{ fontSize: '14px', marginTop: '4px' }}>{new Date(tenant.created_at).toLocaleDateString()}</p></div>
        </div>
      </div>

      {/* Action */}
      {actionError && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', color: '#DC2626', fontSize: '13px', marginBottom: '12px' }}>⚠️ {actionError}</div>}
      <button
        onClick={handleToggleSuspend}
        disabled={actionLoading}
        style={{
          padding: '11px 24px', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
          cursor: actionLoading ? 'not-allowed' : 'pointer',
          background: isSuspended ? 'linear-gradient(135deg, #059669, #047857)' : 'linear-gradient(135deg, #DC2626, #B91C1C)',
          color: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,0.2)', opacity: actionLoading ? 0.6 : 1,
          transition: 'all 150ms',
        }}
      >
        {actionLoading ? 'Processing...' : isSuspended ? 'Reactivate Tenant' : 'Suspend Tenant'}
      </button>
    </div>
  );
}
