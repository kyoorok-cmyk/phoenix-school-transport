@echo off
echo Fixing auth functions...
(
echo CREATE OR REPLACE FUNCTION public.get_tenant_id^(^) RETURNS UUID
echo LANGUAGE plpgsql STABLE SECURITY DEFINER AS $fn$
echo DECLARE v_val TEXT;
echo BEGIN
echo   v_val := current_setting^('request.jwt.claims', true^)::json -^> 'user_metadata' -^>^> 'tenant_id';
echo   IF v_val IS NULL OR v_val = '' THEN RETURN NULL; END IF;
echo   RETURN v_val::UUID;
echo EXCEPTION WHEN OTHERS THEN RETURN NULL;
echo END; $fn$;
echo.
echo CREATE OR REPLACE FUNCTION public.get_user_role^(^) RETURNS TEXT
echo LANGUAGE plpgsql STABLE SECURITY DEFINER AS $fn$
echo BEGIN
echo   RETURN current_setting^('request.jwt.claims', true^)::json -^> 'user_metadata' -^>^> 'role';
echo EXCEPTION WHEN OTHERS THEN RETURN NULL;
echo END; $fn$;
) | supabase db query --linked
echo.
echo Done. Trying user creation...
echo.
curl -X POST "https://crkivsdsrdbseawfgxzf.supabase.co/auth/v1/signup" ^
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNya2l2c2RzcmRic2Vhd2ZneHpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MDA3ODAsImV4cCI6MjEwMTE3Njc4MH0.KnUqw_DicnHX-_cDGPAoSjYQEogYXTz-H2PTf4hlDU4" ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"admin@phoenixinc.co.za\",\"password\":\"PhoenixAdmin2025!\",\"data\":{\"role\":\"vendor_admin\",\"display_name\":\"Platform Admin\"}}"
echo.
pause
