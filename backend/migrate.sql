-- Add monthly counter fields to existing users
ALTER TABLE users ADD COLUMN IF NOT EXISTS videos_this_period INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS period_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add plan_expires_at to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP WITH TIME ZONE;

-- Add email verification fields (existing users auto-verified so they can still log in)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255);
CREATE INDEX IF NOT EXISTS ix_users_email_verification_token ON users (email_verification_token);

-- Add reply threading (video replies)
ALTER TABLE videos ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES videos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_videos_reply_to_id ON videos (reply_to_id);
