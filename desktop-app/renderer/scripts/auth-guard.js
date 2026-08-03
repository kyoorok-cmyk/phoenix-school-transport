/**
 * Auth Guard — include on every page that requires authentication.
 * Checks localStorage for a valid session and redirects to login.html if missing.
 * Also wires up the logout button.
 */
(function() {
  'use strict';

  var AUTH_KEY = 'phoenix-desktop-auth';

  function getSession() {
    try {
      var stored = localStorage.getItem(AUTH_KEY);
      if (!stored) return null;
      var session = JSON.parse(stored);
      if (!session.access_token || !session.user) return null;
      return session;
    } catch (e) {
      return null;
    }
  }

  function redirectToLogin() {
    // Get relative path to login from current page
    window.location.href = 'login.html';
  }

  function logout() {
    localStorage.removeItem(AUTH_KEY);
    redirectToLogin();
  }

  // Check session on page load
  var session = getSession();
  if (!session) {
    redirectToLogin();
    return;
  }

  // Validate role
  var role = session.user.role;
  if (role !== 'operator' && role !== 'admin') {
    localStorage.removeItem(AUTH_KEY);
    redirectToLogin();
    return;
  }

  // Expose session info for other scripts
  window.phoenixConfig = window.phoenixConfig || {};
  window.phoenixConfig.accessToken = session.access_token;
  window.phoenixConfig.currentUser = session.user;

  // Wire up logout button when DOM is ready
  function wireLogout() {
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function(e) {
        e.preventDefault();
        logout();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLogout);
  } else {
    wireLogout();
  }

  // Expose logout globally for programmatic use
  window.phoenixLogout = logout;
})();
