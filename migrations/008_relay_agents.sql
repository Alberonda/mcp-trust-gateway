-- Some upstream servers can only ever be reached from inside a specific network (e.g. an
-- internal corporate SonarQube/Jenkins instance — see DESIGN.md's "Role-based access
-- control" postscripts for the real incident that found this: a subprocess spawning
-- without crashing only proves the binary starts, not that the network call it will
-- eventually make can succeed). requires_relay marks a server as needing to be executed
-- by a connected relay agent (see adapters/relay/) instead of spawned directly by
-- whichever process is running the gateway — the gateway stays the single source of
-- truth for permissions/credentials/audit either way; only *where the subprocess
-- physically runs* changes.
ALTER TABLE upstream_servers ADD COLUMN requires_relay BOOLEAN NOT NULL DEFAULT false;
