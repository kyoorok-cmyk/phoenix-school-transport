@echo off
echo ============================================================
echo  Creating users for Phoenix School Transport
echo ============================================================
echo.

echo [1/4] Creating operator user via signup...
curl -s -X POST "https://ptskyueshtjjesxeusot.supabase.co/auth/v1/signup" ^
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0c2t5dWVzaHRqamVzeGV1c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg2OTAsImV4cCI6MjEwMTE5NDY5MH0.P9x4uTU9jvY11OkezvxdQlbGrqdFtXH-ik-Vd00MD2Y" ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"operator@test.co.za\",\"password\":\"Operator123!\",\"data\":{\"role\":\"operator\",\"display_name\":\"Test Operator\"}}"
echo.

echo [2/4] Creating test tenant...
supabase db query --linked < create-operator.sql

echo [3/4] Confirming vendor admin email...
echo UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'admin@phoenixinc.co.za'; | supabase db query --linked

echo [4/4] Confirming operator email...
echo UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'operator@test.co.za'; | supabase db query --linked

echo.
echo ============================================================
echo  DONE! Login credentials:
echo ============================================================
echo.
echo  Vendor Portal (http://localhost:5173):
echo    Email: admin@phoenixinc.co.za
echo    Password: PhoenixAdmin2025!
echo.
echo  Desktop App (Electron):
echo    Email: operator@test.co.za
echo    Password: Operator123!
echo.
pause
