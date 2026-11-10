DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admins' AND column_name = 'email') THEN
    ALTER TABLE admins RENAME COLUMN email TO phone;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_invites' AND column_name = 'email') THEN
    ALTER TABLE admin_invites RENAME COLUMN email TO phone;
  END IF;
END $$;
