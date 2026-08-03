import { useState } from 'preact/hooks';
import { supabaseAdmin } from '../services/supabase-admin';

interface LoginProps {
  onLoginSuccess: () => void;
}

export function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.');
      return;
    }

    setLoading(true);

    try {
      const { data, error: authError } = await supabaseAdmin.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim(),
      });

      if (authError) {
        setError(authError.message || 'Login failed. Please check your credentials.');
        return;
      }

      if (!data.user) {
        setError('Login failed. No user returned.');
        return;
      }

      const role = data.user.user_metadata?.role;
      if (role !== 'vendor_admin') {
        // Sign out immediately — unauthorized role
        await supabaseAdmin.auth.signOut();
        setError('Access denied: vendor admin only');
        return;
      }

      // Success — session is stored automatically by Supabase client
      onLoginSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #1E1B2E 0%, #2D1F3D 50%, #1E1B2E 100%)',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '16px',
        padding: '40px',
        width: '400px',
        maxWidth: '90vw',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <span style={{ fontSize: '40px' }}>🚌</span>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#1E293B', marginTop: '12px', letterSpacing: '-0.02em' }}>
            Phoenix Transport
          </h1>
          <p style={{ fontSize: '13px', color: '#64748B', marginTop: '4px' }}>Vendor Admin Portal</p>
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            borderRadius: '8px',
            padding: '10px 14px',
            color: '#DC2626',
            fontSize: '13px',
            fontWeight: 500,
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <span>⚠️</span> {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              placeholder="admin@phoenixinc.co.za"
              required
              style={{
                width: '100%',
                padding: '11px 14px',
                border: '1.5px solid #E2E8F0',
                borderRadius: '8px',
                fontSize: '14px',
                fontFamily: 'inherit',
                outline: 'none',
                transition: 'border-color 150ms',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => ((e.target as HTMLInputElement).style.borderColor = '#8B1A2B')}
              onBlur={(e) => ((e.target as HTMLInputElement).style.borderColor = '#E2E8F0')}
            />
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              placeholder="••••••••"
              required
              style={{
                width: '100%',
                padding: '11px 14px',
                border: '1.5px solid #E2E8F0',
                borderRadius: '8px',
                fontSize: '14px',
                fontFamily: 'inherit',
                outline: 'none',
                transition: 'border-color 150ms',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => ((e.target as HTMLInputElement).style.borderColor = '#8B1A2B')}
              onBlur={(e) => ((e.target as HTMLInputElement).style.borderColor = '#E2E8F0')}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              fontFamily: 'inherit',
              color: '#fff',
              background: loading ? '#94A3B8' : 'linear-gradient(135deg, #8B1A2B 0%, #5C0E1A 100%)',
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 8px rgba(139, 26, 43, 0.3)',
              transition: 'all 150ms',
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: '11px', color: '#94A3B8', marginTop: '20px' }}>
          Phoenix School Transport Management — PhoenixInc
        </p>
      </div>
    </div>
  );
}
