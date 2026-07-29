import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditStatus } from "../../src/constants.js";
import { PostgresAuditLogRepository } from "../../src/db/AuditLogRepository.js";
import type { Queryable } from "../../src/db/Queryable.js";
import { withTransaction } from "./setupDatabase.js";

async function seedIdentity(db: Queryable, name = "agent"): Promise<string> {
  const {
    rows: [identity],
  } = await db.query<{ id: string }>(`INSERT INTO identities (name, api_key_hash) VALUES ($1, 'h') RETURNING id`, [
    name,
  ]);
  return identity.id;
}

test(
  "write() persists every field, including a JSON round-trip of the redacted params",
  withTransaction(async ({ db }) => {
    const identityId = await seedIdentity(db);
    const repo = new PostgresAuditLogRepository(db);

    await repo.write({
      identityId,
      serverName: "github",
      toolName: "create_issue",
      paramsRedacted: { title: "bug report", token: "[REDACTED]" },
      status: AuditStatus.AllowedSuccess,
      resultSummary: "Created issue #42",
      durationMs: 123,
    });

    const [entry] = await repo.findRecentByIdentity(identityId, 10);
    assert.equal(entry.serverName, "github");
    assert.equal(entry.toolName, "create_issue");
    assert.deepEqual(entry.paramsRedacted, { title: "bug report", token: "[REDACTED]" });
    assert.equal(entry.status, AuditStatus.AllowedSuccess);
    assert.equal(entry.resultSummary, "Created issue #42");
    assert.equal(entry.durationMs, 123);
    assert.ok(entry.createdAt instanceof Date);
  }),
);

test(
  "findRecentByIdentity returns newest first and respects the limit",
  withTransaction(async ({ db }) => {
    const identityId = await seedIdentity(db);
    const repo = new PostgresAuditLogRepository(db);

    for (const toolName of ["first", "second", "third"]) {
      await repo.write({
        identityId,
        serverName: "s",
        toolName,
        paramsRedacted: {},
        status: AuditStatus.AllowedSuccess,
        resultSummary: "ok",
        durationMs: 1,
      });
    }

    const entries = await repo.findRecentByIdentity(identityId, 2);

    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => e.toolName),
      ["third", "second"],
      "most recently written entry must come first",
    );
  }),
);

test(
  "findRecentByIdentity never returns another identity's entries",
  withTransaction(async ({ db }) => {
    const identityA = await seedIdentity(db, "identity-a");
    const identityB = await seedIdentity(db, "identity-b");
    const repo = new PostgresAuditLogRepository(db);

    await repo.write({
      identityId: identityA,
      serverName: "s",
      toolName: "tool-a",
      paramsRedacted: {},
      status: AuditStatus.Denied,
      resultSummary: "denied",
      durationMs: 1,
    });
    await repo.write({
      identityId: identityB,
      serverName: "s",
      toolName: "tool-b",
      paramsRedacted: {},
      status: AuditStatus.Denied,
      resultSummary: "denied",
      durationMs: 1,
    });

    const entriesForA = await repo.findRecentByIdentity(identityA, 10);

    assert.equal(entriesForA.length, 1);
    assert.equal(entriesForA[0].toolName, "tool-a");
  }),
);
