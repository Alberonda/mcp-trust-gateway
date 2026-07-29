-- Phase 3: permissions move from being granted per-identity (per API key) to per-user.
-- One user can hold several identities (e.g. a laptop key and a CI key) and both
-- automatically share the same permission grants, instead of needing to be configured
-- separately. See DESIGN.md's Phase 3 section for the full rationale.

CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE identities
    ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill: one user per pre-existing identity, so nothing already granted is silently
-- dropped by this migration. New identities going forward are expected to be explicitly
-- assigned to a (possibly shared) user at creation time instead of relying on this.
INSERT INTO users (id, name, created_at)
SELECT gen_random_uuid(), name, created_at FROM identities WHERE user_id IS NULL;

UPDATE identities i
SET user_id = u.id
FROM users u
WHERE i.user_id IS NULL AND u.name = i.name;

ALTER TABLE identities
    ALTER COLUMN user_id SET NOT NULL;

-- permissions.identity_id -> permissions.user_id. Existing rows carry over via the
-- identities.user_id backfill above (each pre-existing identity's 1:1 shadow user).
ALTER TABLE permissions
    ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE permissions p
SET user_id = i.user_id
FROM identities i
WHERE p.identity_id = i.id;

ALTER TABLE permissions
    ALTER COLUMN user_id SET NOT NULL,
    DROP CONSTRAINT permissions_identity_id_server_id_tool_name_key,
    DROP COLUMN identity_id,
    ADD CONSTRAINT permissions_user_id_server_id_tool_name_key UNIQUE (user_id, server_id, tool_name);

CREATE INDEX idx_permissions_user ON permissions (user_id);
