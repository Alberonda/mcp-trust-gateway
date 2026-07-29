import type { Queryable } from "./Queryable.js";
import type { UpstreamServer } from "./types.js";

/** What registering a new server needs — the same {command, args} shape every MCP client
 *  config uses to describe how to spawn one, minus the `env` part of that shape: a server
 *  never carries its own credential (see db/types.ts's UpstreamServer doc) — every user
 *  who needs one registers it for themselves via UserCredentialRepository instead. */
export interface NewUpstreamServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface UpstreamServerRepository {
  findByName(name: string): Promise<UpstreamServer | null>;
  /** Used by the composition root to resolve every server an identity has any permission
   *  on (see PermissionRepository.findAccessibleServerIds) into the details needed to
   *  actually connect to each one. Empty input returns an empty array without a query. */
  findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]>;
  /** Every registered server, permitted or not — the whitelist itself. Used by
   *  SelfServiceHandler.listServices to show a user what exists even for servers they
   *  don't (yet) have permission on, so they know what to ask an admin for. */
  findAll(): Promise<UpstreamServer[]>;

  /** Registers a new upstream server — see NewUpstreamServer for why this mirrors
   *  standard MCP client config shape directly, minus any credential. */
  create(server: NewUpstreamServer): Promise<UpstreamServer>;
}

interface UpstreamServerRow {
  id: string;
  name: string;
  command: string;
  args: string[];
}

const UPSTREAM_SERVER_COLUMNS = `id, name, command, args`;

function mapRow(row: UpstreamServerRow): UpstreamServer {
  return { id: row.id, name: row.name, command: row.command, args: row.args };
}

export class PostgresUpstreamServerRepository implements UpstreamServerRepository {
  constructor(private readonly db: Queryable) {}

  async findByName(name: string): Promise<UpstreamServer | null> {
    const { rows } = await this.db.query<UpstreamServerRow>(
      `SELECT ${UPSTREAM_SERVER_COLUMNS} FROM upstream_servers WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<UpstreamServer[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<UpstreamServerRow>(
      `SELECT ${UPSTREAM_SERVER_COLUMNS} FROM upstream_servers WHERE id = ANY($1)`,
      [ids],
    );
    return rows.map(mapRow);
  }

  async findAll(): Promise<UpstreamServer[]> {
    const { rows } = await this.db.query<UpstreamServerRow>(`SELECT ${UPSTREAM_SERVER_COLUMNS} FROM upstream_servers ORDER BY name`);
    return rows.map(mapRow);
  }

  async create(server: NewUpstreamServer): Promise<UpstreamServer> {
    const { rows } = await this.db.query<UpstreamServerRow>(
      `INSERT INTO upstream_servers (name, command, args)
       VALUES ($1, $2, $3)
       RETURNING ${UPSTREAM_SERVER_COLUMNS}`,
      [server.name, server.command, JSON.stringify(server.args)],
    );
    return mapRow(rows[0]);
  }
}
