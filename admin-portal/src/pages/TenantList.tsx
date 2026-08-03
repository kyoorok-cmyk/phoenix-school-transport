import { useEffect, useState } from 'preact/hooks';
import { supabaseAdmin } from '../services/supabase-admin';

interface Tenant {
  id: string;
  company_name: string;
  contact_email: string;
  subscription_tier: string;
  subscription_status: string;
  created_at: string;
}

const SUPABASE_URL = 'https://crkivsdsrdbseawfgxzf.supabase.co';

export function TenantList() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [form, setForm] = useState({
    company_name: '',
    contact_email: '',
    admin_full_name: '',
    admin_password: '',
    subscription_tier: 'professional',
  });

  useEffect(() => { loadTenants(); }, []);

  async function loadTenants() {
    setLoading(true);
    setError('');
    try {
      const { data, error: err } = await supabaseAdmin
        .from('tenants').select('*').order('created_at', { ascending: false });
      if (err) throw new Error(err.message);
      setTenants(data || []);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load tenants';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    setFormError('');
    setFormSuccess('');

    if (!form.company_name.trim() || !form.contact_email.trim() || !form.admin_full_name.trim()) {
      setFormError('Company name, admin email, and admin name are required.');
      return;
    }

    if (!form.admin_password.trim() || form.admin_password.trim().length < 8) {
      setFormError('Admin password must be at least 8 characters.');
      return;
    }

    setCreating(true);
    try {
      // Get current session token for authorization
      const { data: sessionData } = await supabaseAdmin.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      if (!accessToken) {
        setFormError('Not authenticated. Please sign in again.');
        return;
      }

      // Call the provision-transport-tenant Edge Function (uses service_role internally)
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/provision-transport-tenant`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            company_name: form.company_name.trim(),
            admin_email: form.contact_email.trim(),
            admin_full_name: form.admin_full_name.trim(),
            admin_password: form.admin_password.trim(),
            subscription_tier: form.subscription_tier,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        const errorMsg = result.error || result.details?.join(', ') || 'Failed to provision tenant';
        throw new Error(errorMsg);
      }

      setFormSuccess(`Tenant "${form.company_name}" created successfully! (ID: ${result.tenant_id})`);
      setForm({ company_name: '', contact_email: '', admin_full_name: '', admin_password: '', subscription_tier: 'professional' });
      setTimeout(() => { setShowForm(false); setFormSuccess(''); loadTenants(); }, 2000);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to provision tenant';
      setFormError(message);
    } finally {
      setCreating(false);
    }
  }

  const s = {
    card: { background: '#fff', borderRadius: '12px', border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' } as const,
    th: { padding: '14px 20px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#64748B', background: 'linear-gradient(180deg, #FAFBFC, #F1F5F9)', borderBottom: '1px solid #E2E8F0', textAlign: 'left' } as const,
    td: { padding: '14px 20px', borderBottom: '1px solid #F1F5F9', fontSize: '14px' } as const,
    badge: (color: string, bg: string) => ({ padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 600, color, background: bg, display: 'inline-block' }),
    input: { width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0', borderRadius: '8px', fontSize: '14px', fontFamily: 'Inter, sans-serif', outline: 'none', transition: 'border-color 150ms', boxSizing: 'border-box' as const } as const,
    label: { fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '5px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.3px' } as const,
  };

  if (loading) return <div style={{ padding: '60px', textAlign: 'center', color: '#94A3B8' }}>Loading tenants...</div>;
  if (error) return <div style={{ padding: '20px', background: '#FEF2F2', color: '#DC2626', borderRadius: '8px' }}>{error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em' }}>Transport Tenants</h2>
          <p style={{ fontSize: '13px', color: '#64748B', marginTop: '4px' }}>{tenants.length} registered transport operator{tenants.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => { setShowForm(true); setFormError(''); setFormSuccess(''); }} style={{
          padding: '10px 20px', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
          background: 'linear-gradient(135deg, #059669, #047857)', color: '#fff', cursor: 'pointer',
          boxShadow: '0 2px 6px rgba(5,150,105,0.3)', transition: 'all 150ms',
        }}>+ Add Tenant</button>
      </div>

      {/* Provision Form Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={() => setShowForm(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(4px)' }} />
          <div style={{ position: 'relative', background: '#fff', borderRadius: '16px', width: '520px', padding: '28px', boxShadow: '0 20px 25px rgba(0,0,0,0.1)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '20px' }}>Provision New Tenant</h3>

            {formError && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '10px 14px', color: '#DC2626', fontSize: '13px', marginBottom: '14px' }}>{formError}</div>}
            {formSuccess && <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: '8px', padding: '10px 14px', color: '#065F46', fontSize: '13px', marginBottom: '14px' }}>{formSuccess}</div>}

            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>Company Name *</label>
              <input style={s.input} value={form.company_name} onInput={(e) => setForm({ ...form, company_name: (e.target as HTMLInputElement).value })} placeholder="e.g. KZN School Transport" />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>Admin Email *</label>
              <input style={s.input} type="email" value={form.contact_email} onInput={(e) => setForm({ ...form, contact_email: (e.target as HTMLInputElement).value })} placeholder="admin@company.co.za" />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>Admin Full Name *</label>
              <input style={s.input} value={form.admin_full_name} onInput={(e) => setForm({ ...form, admin_full_name: (e.target as HTMLInputElement).value })} placeholder="e.g. John Dlamini" />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>Admin Password *</label>
              <input style={s.input} type="password" value={form.admin_password} onInput={(e) => setForm({ ...form, admin_password: (e.target as HTMLInputElement).value })} placeholder="Min 8 characters" />
              <p style={{ fontSize: '11px', color: '#94A3B8', marginTop: '4px' }}>This will be the operator's initial login password.</p>
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={s.label}>Subscription Tier</label>
              <select style={{ ...s.input, appearance: 'auto' }} value={form.subscription_tier} onChange={(e) => setForm({ ...form, subscription_tier: (e.target as HTMLSelectElement).value })}>
                <option value="starter">Starter</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '10px 18px', border: '1px solid #E2E8F0', borderRadius: '8px', background: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleCreate} disabled={creating} style={{
                padding: '10px 20px', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                background: creating ? '#94A3B8' : 'linear-gradient(135deg, #8B1A2B, #5C0E1A)', color: '#fff',
                cursor: creating ? 'not-allowed' : 'pointer', boxShadow: '0 2px 6px rgba(139,26,43,0.3)',
              }}>{creating ? 'Provisioning...' : 'Create Tenant'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Tenant Table */}
      {tenants.length === 0 ? (
        <div style={{ ...s.card, padding: '60px', textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚌</div>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>No tenants yet</h3>
          <p style={{ fontSize: '13px', color: '#94A3B8', marginBottom: '20px' }}>Click "+ Add Tenant" to onboard your first transport operator.</p>
        </div>
      ) : (
        <div style={s.card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={s.th}>Company</th>
                <th style={s.th}>Email</th>
                <th style={s.th}>Tier</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Created</th>
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} style={{ transition: 'background 150ms' }} onMouseOver={(e) => (e.currentTarget.style.background = '#F8FAFF')} onMouseOut={(e) => (e.currentTarget.style.background = '')}>
                  <td style={{ ...s.td, fontWeight: 600 }}>{t.company_name}</td>
                  <td style={{ ...s.td, color: '#64748B' }}>{t.contact_email}</td>
                  <td style={s.td}><span style={s.badge('#1E40AF', '#DBEAFE')}>{t.subscription_tier}</span></td>
                  <td style={s.td}><span style={s.badge(
                    t.subscription_status === 'active' ? '#065F46' : '#991B1B',
                    t.subscription_status === 'active' ? '#D1FAE5' : '#FEE2E2'
                  )}>{t.subscription_status}</span></td>
                  <td style={{ ...s.td, color: '#94A3B8', fontSize: '13px' }}>{new Date(t.created_at).toLocaleDateString()}</td>
                  <td style={s.td}><a href={`#/tenants/${t.id}`} style={{ color: '#8B1A2B', fontWeight: 600, fontSize: '13px', textDecoration: 'none' }}>View →</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
