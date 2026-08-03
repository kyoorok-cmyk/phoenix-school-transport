-- Create vendor admin user for the admin portal
-- Run this via Supabase SQL Editor or CLI

DO $$
DECLARE
  new_user_id uuid;
BEGIN
  -- Check if user already exists
  SELECT id INTO new_user_id FROM auth.users WHERE email = 'admin@phoenixinc.co.za';
  
  IF new_user_id IS NOT NULL THEN
    -- Update existing user
    UPDATE auth.users SET
      encrypted_password = crypt('PhoenixAdmin2025!', gen_salt('bf')),
      raw_user_meta_data = '{"role": "vendor_admin"}'::jsonb,
      email_confirmed_at = now(),
      updated_at = now()
    WHERE id = new_user_id;
  ELSE
    -- Create new user
    new_user_id := gen_random_uuid();
    
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
      created_at, updated_at, confirmation_token, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      new_user_id,
      'authenticated',
      'authenticated',
      'admin@phoenixinc.co.za',
      crypt('PhoenixAdmin2025!', gen_salt('bf')),
      now(),
      '{"role": "vendor_admin"}'::jsonb,
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      now(),
      now(),
      '',
      ''
    );

    -- Create identity record (required for email/password login)
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) VALUES (
      new_user_id,
      new_user_id,
      jsonb_build_object('sub', new_user_id::text, 'email', 'admin@phoenixinc.co.za', 'email_verified', true),
      'email',
      new_user_id::text,
      now(),
      now(),
      now()
    );
  END IF;
  
  RAISE NOTICE 'Vendor admin user created/updated with ID: %', new_user_id;
END $$;
