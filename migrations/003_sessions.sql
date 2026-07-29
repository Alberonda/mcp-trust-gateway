-- Phase 3b: short-lived session tokens, issued via a login step (HTTP mode only — see
-- DESIGN.md). A session remembers BOTH which user it acts as (for permission checks) and
-- which identity/API key was used to create it (for audit attribution) — logging in
-- doesn't lose the "which specific credential did this" granularity ToolCallHandler's
-- audit trail already relies on.

CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_id  UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
