-- Phase 1 schema — see DESIGN.md for the full rationale.
-- gen_random_uuid() is a PostgreSQL 13+ built-in, no extension required.

CREATE TABLE identities (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,      -- human-readable label, e.g. "alberto-devin-cli"
    api_key_hash  TEXT NOT NULL,             -- hash of the API key (see src/crypto.ts) — plaintext never stored
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The real MCP servers the gateway is allowed to proxy to.
CREATE TABLE upstream_servers (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT NOT NULL UNIQUE,   -- e.g. "github", "qdrant"
    command               TEXT NOT NULL,          -- launch command, e.g. "npx -y @modelcontextprotocol/server-github"
    encrypted_credential  BYTEA,                  -- AES-256-GCM ciphertext of whatever secret this server needs
    credential_iv         BYTEA,                  -- initialization vector used for the encryption
    credential_auth_tag   BYTEA,                  -- GCM auth tag, required to decrypt
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ACL: which identity may call which (server, tool) pair. tool_name NULL = every tool on that server.
CREATE TABLE permissions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id  UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    server_id    UUID NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
    tool_name    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (identity_id, server_id, tool_name)
);

-- Every tool call attempt, allowed or denied — the audit trail this whole project exists for.
CREATE TABLE audit_log (
    id               BIGSERIAL PRIMARY KEY,
    identity_id      UUID REFERENCES identities(id) ON DELETE SET NULL,
    server_name      TEXT NOT NULL,
    tool_name        TEXT NOT NULL,
    params_redacted  JSONB,             -- call params with secret-looking fields redacted, never raw secrets
    status           TEXT NOT NULL CHECK (status IN ('allowed_success', 'allowed_failure', 'denied')),
    result_summary   TEXT,              -- short human-readable summary, not the full result payload
    duration_ms      INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_identity ON audit_log (identity_id);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX idx_permissions_identity ON permissions (identity_id);
