// Phoenix School Transport - Init Script
(function() {
  'use strict';
  window.phoenixConfig = {
    supabaseUrl: 'https://ptskyueshtjjesxeusot.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0c2t5dWVzaHRqamVzeGV1c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg2OTAsImV4cCI6MjEwMTE5NDY5MH0.P9x4uTU9jvY11OkezvxdQlbGrqdFtXH-ik-Vd00MD2Y',
  };

  try {
    var sessionStr = localStorage.getItem('phoenix-desktop-auth');
    if (sessionStr) {
      var session = JSON.parse(sessionStr);
      window.phoenixConfig.accessToken = session.access_token || '';
    }
  } catch(e) {}

  window.__phoenixServices = window.__phoenixServices || {};
  window.__phoenixServicesReady = false;
})();
