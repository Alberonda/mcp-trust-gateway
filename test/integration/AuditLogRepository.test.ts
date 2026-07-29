import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditStatus } from "../../src/constants.js";
import { PostgresAuditLogRepository } from "../../src/db/AuditLogRepository.js";
import { seedUserAndIdentity } from "./testFixtures.js";
import { withTransaction } from "./setupDatabase.js";
import type { Queryable } from "../../src/db/Queryable.js";

/** audit_log still records identity_id (which specific credential made a call), not
 *  user_id — see ToolCallHandler's comment on that decision — so tests here only need
 *  the identityId half of seedUserAndIdentity's result. */
async function seedIdentity(db: Queryable, name = "agent"): Promise<string> {
  return (await seedUserAndIdentity(db, name)).identityId;
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

test(
  "search() with no filters returns the most recent entries across every identity",
  withTransaction(async ({ db }) => {
    const repo = new PostgresAuditLogRepository(db);
    const identityA = await seedIdentity(db, "identity-a");
    const identityB = await seedIdentity(db, "identity-b");
    for (const identityId of [identityA, identityB]) {
      await repo.write({
        identityId,
        serverName: "s",
        toolName: "t",
        paramsRedacted: {},
        status: AuditStatus.AllowedSuccess,
        resultSummary: "ok",
        durationMs: 1,
      });
    }

    const results = await repo.search({ limit: 10 });

    assert.equal(results.length, 2, "no filters means every identity's entries are eligible");
  }),
);

test(
  "search() filters by identity name, and includes it in the result for display",
  withTransaction(async ({ db }) => {
    const repo = new PostgresAuditLogRepository(db);
    const identityA = await seedIdentity(db, "identity-a");
    await seedIdentity(db, "identity-b"); // no entries written for this one
    await repo.write({
      identityId: identityA,
      serverName: "s",
      toolName: "t",
      paramsRedacted: {},
      status: AuditStatus.AllowedSuccess,
      resultSummary: "ok",
      durationMs: 1,
    });

    const results = await repo.search({ identityName: "identity-a", limit: 10 });

    assert.equal(results.length, 1);
    assert.equal(results[0].identityName, "identity-a");
  }),
);

test(
  "search() filters by server name and status, combined",
  withTransaction(async ({ db }) => {
    const repo = new PostgresAuditLogRepository(db);
    const identityId = await seedIdentity(db, "agent");
    await repo.write({
      identityId,
      serverName: "server-a",
      toolName: "t",
      paramsRedacted: {},
      status: AuditStatus.Denied,
      resultSummary: "denied",
      durationMs: 1,
    });
    await repo.write({
      identityId,
      serverName: "server-a",
      toolName: "t",
      paramsRedacted: {},
      status: AuditStatus.AllowedSuccess,
      resultSummary: "ok",
      durationMs: 1,
    });
    await repo.write({
      identityId,
      serverName: "server-b",
      toolName: "t",
      paramsRedacted: {},
      status: AuditStatus.Denied,
      resultSummary: "denied",
      durationMs: 1,
    });

    const results = await repo.search({ serverName: "server-a", status: AuditStatus.Denied, limit: 10 });

    assert.equal(results.length, 1, "only the entry matching BOTH filters should be returned");
    assert.equal(results[0].serverName, "server-a");
    assert.equal(results[0].status, AuditStatus.Denied);
  }),
);

test(
  "search() respects the limit",
  withTransaction(async ({ db }) => {
    const repo = new PostgresAuditLogRepository(db);
    const identityId = await seedIdentity(db, "agent");
    for (let i = 0; i < 5; i++) {
      await repo.write({
        identityId,
        serverName: "s",
        toolName: `t${i}`,
        paramsRedacted: {},
        status: AuditStatus.AllowedSuccess,
        resultSummary: "ok",
        durationMs: 1,
      });
    }

    const results = await repo.search({ limit: 2 });

    assert.equal(results.length, 2);
  }),
);
