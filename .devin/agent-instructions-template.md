# Agent instructions template — enforcing "only through the trust gateway"

Copy the block below into your own project's agent instructions file (Devin CLI's
`AGENTS.md`, Claude's `CLAUDE.md`, a Cursor rules file, etc.) — wherever your agent reads
persistent instructions from. This alone doesn't *technically* prevent an agent from
configuring another MCP server directly (this project's authorization happens at the
gateway, not by restricting what an agent's config file can contain) — its job is to
make the gateway the obvious, only-documented path, so nobody works around the
governance this project exists to provide out of not knowing it's there. Real
enforcement is what the gateway itself already does: an agent that DOES connect
somewhere else directly simply gets no audit trail, no permission check, and no
credential brokering for that connection — the whole point this project exists to solve
stays unsolved for that one connection, but nothing here can force a client's config to
be honest. Treat this as documentation hygiene, not a security control.

---

## MCP servers: always through mcp-trust-gateway

This project's real integrations (Jira, SonarQube, GitHub, etc.) are never connected to
directly. They are proxied through `mcp-trust-gateway`, which adds per-role permissions,
an audit trail, and encrypted per-user credential brokering that a direct connection
would have none of.

- **Never** add a new `mcpServers` entry that points at a real integration's own MCP
  server (its own npm package, its own Docker image, its own URL). If you think you need
  a new integration, ask a human to register it with the gateway instead (see the
  gateway's `OPERATIONS.md` — `manage_roles`' `register_server` action) — don't
  configure it yourself, even temporarily "just to test something."
- **Always** discover and call real tools through the gateway's own meta-tools:
  `find_tool({query})` to search across every server you're actually permitted on, then
  `call_tool({server, tool, arguments})` to invoke one. Don't assume a tool doesn't exist
  just because it's not in your context — `find_tool` searches semantically, so try a
  natural-language description before concluding it isn't available.
- If `find_tool`/`call_tool` return `not_permitted` or a permission error, that's a real
  access decision an admin made — don't try to work around it by finding another way to
  reach the same integration. Ask a human to grant access via `manage_roles`' own
  `grant_permission` action if you genuinely need it.
- If a server you need shows up in `list_services` as `needs_credential`, that's on you
  to fix, not an admin — call `register_my_credential({server, env})` with your own
  token for that service. Never ask a human for a shared/team credential to hardcode
  somewhere; every user brings their own.
