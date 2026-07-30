-- Lets an admin issue a one-time signup token instead of having to run a provisioning
-- script by hand for every new teammate (see DESIGN.md's "Self-service onboarding").
-- Redeeming one creates a brand new user + identity + API key and assigns the token's
-- role -- HTTP mode only (see entrypoints/http/httpServer.ts's /redeem-invitation).

CREATE TABLE invitation_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE,      -- same SHA-256-of-a-high-entropy-secret approach as api_key_hash
    role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    used_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitation_tokens_token_hash ON invitation_tokens (token_hash);
