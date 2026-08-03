UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'admin@phoenixinc.co.za';
UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'operator@test.co.za';
INSERT INTO tenants (name, company_name, contact_email, subscription_tier)
SELECT 'Test Transport', 'Test Transport Co', 'operator@test.co.za', 'professional'
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE contact_email = 'operator@test.co.za');
