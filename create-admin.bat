@echo off
echo Creating vendor admin user...
curl -s -X POST "https://ptskyueshtjjesxeusot.supabase.co/auth/v1/signup" ^
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0c2t5dWVzaHRqamVzeGV1c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg2OTAsImV4cCI6MjEwMTE5NDY5MH0.P9x4uTU9jvY11OkezvxdQlbGrqdFtXH-ik-Vd00MD2Y" ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"admin@phoenixinc.co.za\",\"password\":\"PhoenixAdmin2025!\",\"data\":{\"role\":\"vendor_admin\",\"display_name\":\"Platform Admin\"}}"
echo.
echo.
echo If successful, try logging in at http://localhost:5173
echo   Email: admin@phoenixinc.co.za
echo   Password: PhoenixAdmin2025!
pause
