INSERT INTO tenants (name, company_name, contact_email, subscription_tier)
VALUES ('Test Transport', 'Test Transport Co', 'operator@test.co.za', 'professional');

UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = 'operator@test.co.za';
