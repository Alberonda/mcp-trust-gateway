import type { UpstreamServer } from "../../domain/types.js";
import type { NewUpstreamServer, UpstreamServerRepository } from "../../ports/UpstreamServerRepository.js";
import type { Queryable } from "../../ports/Queryable.js";

interface UpstreamServerRow {
  id: string;
  name: string;
  command: string;
  args: string[];
  requiresRelay: boolean;
}

const UPSTREAM_SERVER_COLUMNS = `id, name, command, args, requires_relay AS "requiresRelay"`;

function mapRow(row: UpstreamServerRow): UpstreamServer {
  return { id: row.id, name: row.name, command: row.command, args: row.args, requiresRelay: row.requiresRelay };
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
      `INSERT INTO upstream_servers (name, command, args, requires_relay)
       VALUES ($1, $2, $3, $4)
       RETURNING ${UPSTREAM_SERVER_COLUMNS}`,
      [server.name, server.command, JSON.stringify(server.args), server.requiresRelay ?? false],
    );
    return mapRow(rows[0]);
  }
}
