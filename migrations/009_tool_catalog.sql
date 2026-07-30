-- A cached record of what tools each real upstream server offers, so find_tool can
-- search across every accessible server without connecting (spawning a real subprocess)
-- to each one on every session — see DESIGN.md's backlog entry on this, added
-- 2026-07-29. embedding is a plain float array, not a pgvector column: at this
-- project's real scale (tens of tools per server, not millions), a linear cosine-
-- similarity scan in application code is fast enough that a dedicated vector index
-- would be premature — revisit only if that assumption stops holding.
CREATE TABLE tool_catalog (
    server_id    UUID NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
    tool_name    TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    embedding    REAL[] NOT NULL,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, tool_name)
);
