@echo off
echo Creating test operator user...
curl -s -X POST "https://ptskyueshtjjesxeusot.supabase.co/auth/v1/signup" ^
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0c2t5dWVzaHRqamVzeGV1c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg2OTAsImV4cCI6MjEwMTE5NDY5MH0.P9x4uTU9jvY11OkezvxdQlbGrqdFtXH-ik-Vd00MD2Y" ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"operator@test.co.za\",\"password\":\"Operator123!\",\"data\":{\"role\":\"operator\",\"display_name\":\"Test Operator\"}}"
echo.
echo.
echo Now confirm email in SQL Editor:
echo   UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'operator@test.co.za';
echo.
echo Then login to the Desktop App with:
echo   Email: operator@test.co.za
echo   Password: Operator123!
pause
