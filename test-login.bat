@echo off
echo Testing login via API...
curl -s -X POST "https://crkivsdsrdbseawfgxzf.supabase.co/auth/v1/token?grant_type=password" ^
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNya2l2c2RzcmRic2Vhd2ZneHpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MDA3ODAsImV4cCI6MjEwMTE3Njc4MH0.KnUqw_DicnHX-_cDGPAoSjYQEogYXTz-H2PTf4hlDU4" ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"admin@phoenixinc.co.za\",\"password\":\"PhoenixAdmin2025!\"}"
echo.
pause
