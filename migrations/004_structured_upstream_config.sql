-- Adopts the de facto MCP server config standard every MCP client already converged on
-- (Claude Desktop, Cursor, VS Code, Devin CLI): { command, args, env }. Before this,
-- upstream_servers.command was one naively-space-split string, and only a single secret
-- could be injected as UPSTREAM_CREDENTIAL — insufficient for a real server needing
-- several named env vars (e.g. SonarQube's SONARQUBE_TOKEN + SONARQUBE_URL). See
-- DESIGN.md for the full rationale.

ALTER TABLE upstream_servers
    ADD COLUMN args JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill existing rows: split the old single-string command on whitespace, first token
-- becomes the new `command`, the rest becomes `args`. This matches exactly what
-- UpstreamConnectionProvider was already doing at runtime (naive command.split(" ")), so
-- it's a lossless migration of every server registered so far.
UPDATE upstream_servers
SET args = to_jsonb((string_to_array(command, ' '))[2:array_length(string_to_array(command, ' '), 1)]),
    command = (string_to_array(command, ' '))[1]
WHERE command LIKE '% %';

-- encrypted_credential/credential_iv/credential_auth_tag keep their column names (still
-- "the encrypted secret payload for this server") but their *meaning* changes: the
-- decrypted plaintext is now a JSON-serialized map of every env var this server needs
-- (e.g. '{"SONARQUBE_TOKEN":"...","SONARQUBE_URL":"..."}'), not a single opaque string.
-- No column change needed for that — CredentialVault already encrypts/decrypts arbitrary
-- strings, and a JSON string is still just a string.
