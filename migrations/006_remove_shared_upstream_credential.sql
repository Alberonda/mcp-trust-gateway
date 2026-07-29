-- Removes the concept of a "default" shared credential on upstream_servers entirely.
-- Called out directly, correctly, as a bad practice: whoever registered a server with
-- their own PAT was implicitly the "privileged" user everyone else's calls fell back to.
-- Going forward there is no privileged default — every user, including whoever registers
-- a server, gets their own row in user_credentials, encrypted the same way as anyone
-- else's. A server with no user_credentials row for a given user simply has no credential
-- for that user; there is nothing left to fall back to.
--
-- Backfill: any server that currently has a default credential gets that credential
-- copied into user_credentials for every user who currently has a permission grant on it
-- — preserves who can connect today (no one loses access mid-migration), without
-- pretending this retroactively separates a secret that was, until now, genuinely shared.
-- Whoever kept using it afterward is expected to rotate to their own real value via
-- scripts/set_user_credential.ts.
INSERT INTO user_credentials (user_id, server_id, encrypted_credential, credential_iv, credential_auth_tag)
SELECT DISTINCT p.user_id, s.id, s.encrypted_credential, s.credential_iv, s.credential_auth_tag
FROM upstream_servers s
JOIN permissions p ON p.server_id = s.id
WHERE s.encrypted_credential IS NOT NULL
ON CONFLICT (user_id, server_id) DO NOTHING;

ALTER TABLE upstream_servers
    DROP COLUMN encrypted_credential,
    DROP COLUMN credential_iv,
    DROP COLUMN credential_auth_tag;
