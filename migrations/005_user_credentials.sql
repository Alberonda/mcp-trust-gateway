-- Per-(user, server) credential overrides. Before this, one upstream_servers row had
-- exactly one credential/env map, shared by every user granted permission on it — meaning
-- whoever registered "github" or "sonarqube" with their own personal access token was
-- effectively lending it to every other user of the gateway. Real problem for any service
-- where individual accountability matters (a PAT-backed integration, not a shared sandbox).
--
-- Resolution order (see gateway/PerUserCredentialResolver.ts): if a user has their own row
-- here for a server, use it; otherwise fall back to upstream_servers' own default
-- credential (still useful for genuinely shared resources, e.g. a read-only sandbox).

CREATE TABLE user_credentials (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id             UUID NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
    encrypted_credential  BYTEA NOT NULL,
    credential_iv         BYTEA NOT NULL,
    credential_auth_tag   BYTEA NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, server_id)
);

CREATE INDEX idx_user_credentials_user_server ON user_credentials (user_id, server_id);
