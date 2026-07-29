-- Moves permissions from being granted per-user to being granted per-role, and
-- introduces an admin role that can manage roles/users/credentials. A user's effective
-- access is now the union of every role they hold, matching how real organizations
-- actually assign access ("developer", "hr", "marketing", ...) instead of one-off grants
-- per person.

CREATE TABLE roles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT UNIQUE NOT NULL,
    is_admin   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role_id ON user_roles (role_id);

-- Backfill: give every user who currently has any permission grant their own
-- personal role (named after them), carrying over their exact existing grants —
-- lossless, no one's access changes as a result of this migration. Operators can
-- introduce real shared roles (e.g. "developer") afterward and move users onto them;
-- these auto-created personal roles are just the safe starting point.
INSERT INTO roles (name)
SELECT DISTINCT u.name FROM permissions p JOIN users u ON u.id = p.user_id;

INSERT INTO user_roles (user_id, role_id)
SELECT DISTINCT p.user_id, r.id
FROM permissions p
JOIN users u ON u.id = p.user_id
JOIN roles r ON r.name = u.name;

ALTER TABLE permissions ADD COLUMN role_id UUID REFERENCES roles(id) ON DELETE CASCADE;

UPDATE permissions p
SET role_id = r.id
FROM users u, roles r
WHERE p.user_id = u.id AND r.name = u.name;

ALTER TABLE permissions ALTER COLUMN role_id SET NOT NULL;

DROP INDEX idx_permissions_user;
ALTER TABLE permissions
    DROP CONSTRAINT permissions_user_id_server_id_tool_name_key,
    DROP COLUMN user_id,
    ADD CONSTRAINT permissions_role_id_server_id_tool_name_key UNIQUE (role_id, server_id, tool_name);

CREATE INDEX idx_permissions_role ON permissions (role_id);
