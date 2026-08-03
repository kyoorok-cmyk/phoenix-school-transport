import { useState, useEffect } from 'preact/hooks';
import { TenantList } from './pages/TenantList';
import { TenantDetail } from './pages/TenantDetail';
import { Login } from './pages/Login';
import { supabaseAdmin } from './services/supabase-admin';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [userEmail, setUserEmail] = useState('');
  const [route, setRoute] = useState<{ page: string; id?: string }>({ page: 'list' });

  // Check auth state on load
  useEffect(() => {
    async function checkSession() {
      try {
        const { data: { session } } = await supabaseAdmin.auth.getSession();
        if (session?.user) {
          const role = session.user.user_metadata?.role;
          if (role === 'vendor_admin') {
            setUserEmail(session.user.email || '');
            setAuthState('authenticated');
          } else {
            // Wrong role — sign out
            await supabaseAdmin.auth.signOut();
            setAuthState('unauthenticated');
          }
        } else {
          setAuthState('unauthenticated');
        }
      } catch (err) {
        console.error('[App] Failed to check session:', err);
        setAuthState('unauthenticated');
      }
    }

    checkSession();

    // Listen for auth state changes (e.g., token refresh, sign out)
    const { data: { subscription } } = supabaseAdmin.auth.onAuthStateChange((_event, session) => {
      if (session?.user && session.user.user_metadata?.role === 'vendor_admin') {
        setUserEmail(session.user.email || '');
        setAuthState('authenticated');
      } else if (!session) {
        setUserEmail('');
        setAuthState('unauthenticated');
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Hash-based routing
  useEffect(() => {
    function handleNav() {
      const hash = window.location.hash;
      if (hash.startsWith('#/tenants/')) {
        setRoute({ page: 'detail', id: hash.replace('#/tenants/', '') });
      } else {
        setRoute({ page: 'list' });
      }
    }

    document.addEventListener('click', (e) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href?.startsWith('#')) return;
        if (href?.startsWith('/tenants/')) {
          e.preventDefault();
          window.location.hash = `#${href}`;
        } else if (href === '/tenants' || href === '#/') {
          e.preventDefault();
          window.location.hash = '#/';
        }
      }
    });

    window.addEventListener('hashchange', handleNav);
    handleNav();
    return () => window.removeEventListener('hashchange', handleNav);
  }, []);

  async function handleLogout() {
    try {
      await supabaseAdmin.auth.signOut();
    } catch (err) {
      console.error('[App] Logout error:', err);
    }
    setAuthState('unauthenticated');
    setUserEmail('');
  }

  function handleLoginSuccess() {
    // Re-check session to populate email
    supabaseAdmin.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUserEmail(session.user.email || '');
      }
    });
    setAuthState('authenticated');
  }

  // Loading state
  if (authState === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8FAFC' }}>
        <p style={{ color: '#64748B', fontSize: '14px' }}>Loading...</p>
      </div>
    );
  }

  // Not authenticated — show login
  if (authState === 'unauthenticated') {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  // Authenticated — show main app
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top nav bar */}
      <header style={{
        background: 'linear-gradient(135deg, #1E1B2E 0%, #2D1F3D 100%)',
        padding: '0 32px',
        height: '60px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <a href="#/" style={{ color: '#fff', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '22px' }}>🚌</span>
          <span style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em' }}>Phoenix Transport</span>
          <span style={{ fontSize: '11px', fontWeight: 500, background: 'rgba(212,168,67,0.2)', color: '#D4A843', padding: '2px 8px', borderRadius: '12px', marginLeft: '8px' }}>Admin</span>
        </a>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{userEmail}</span>
          <button
            onClick={handleLogout}
            style={{
              padding: '6px 14px',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              background: 'rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.8)',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 150ms',
            }}
            onMouseOver={(e) => { (e.target as HTMLButtonElement).style.background = 'rgba(255,255,255,0.15)'; }}
            onMouseOut={(e) => { (e.target as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, maxWidth: '1200px', width: '100%', margin: '0 auto', padding: '32px' }}>
        {route.page === 'list' && <TenantList />}
        {route.page === 'detail' && route.id && <TenantDetail id={route.id} />}
      </main>

      {/* Footer */}
      <footer style={{
        textAlign: 'center',
        padding: '16px',
        fontSize: '11px',
        color: '#94A3B8',
        borderTop: '1px solid #E2E8F0',
      }}>
        Phoenix School Transport Management — Developed by Freddy · PhoenixInc
      </footer>
    </div>
  );
}
