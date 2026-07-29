import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEntry, AuditLogRepository, AuditLogRow, StoredAuditEntry } from "../ports/AuditLogRepository.js";
import { SafeAuditLogRepository } from "./SafeAuditLogRepository.js";

const sampleEntry: AuditEntry = {
  identityId: "id-1",
  serverName: "server",
  toolName: "tool",
  paramsRedacted: {},
  status: "allowed_success",
  resultSummary: "ok",
  durationMs: 1,
};

class ThrowingAuditLogRepository implements AuditLogRepository {
  async write(): Promise<void> {
    throw new Error("Postgres is unreachable");
  }
  async findRecentByIdentity(): Promise<StoredAuditEntry[]> {
    throw new Error("Postgres is unreachable");
  }
  async search(): Promise<AuditLogRow[]> {
    throw new Error("Postgres is unreachable");
  }
}

class RecordingAuditLogRepository implements AuditLogRepository {
  readonly written: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.written.push(entry);
  }
  async findRecentByIdentity(): Promise<StoredAuditEntry[]> {
    return [];
  }
  async search(): Promise<AuditLogRow[]> {
    return [];
  }
}

test("write() never throws, even when the wrapped repository's write() does", async () => {
  const safe = new SafeAuditLogRepository(new ThrowingAuditLogRepository(), () => {});

  await assert.doesNotReject(() => safe.write(sampleEntry));
});

test("write() reports the failure via the injected callback instead of swallowing it silently", async () => {
  const reported: Array<{ error: unknown; entry: AuditEntry }> = [];
  const safe = new SafeAuditLogRepository(new ThrowingAuditLogRepository(), (error, entry) =>
    reported.push({ error, entry }),
  );

  await safe.write(sampleEntry);

  assert.equal(reported.length, 1);
  assert.equal(reported[0].entry, sampleEntry);
  assert.ok(reported[0].error instanceof Error);
});

test("write() still delegates to the wrapped repository when it succeeds", async () => {
  const inner = new RecordingAuditLogRepository();
  const safe = new SafeAuditLogRepository(inner, () => {});

  await safe.write(sampleEntry);

  assert.deepEqual(inner.written, [sampleEntry]);
});

test("findRecentByIdentity is NOT swallowed — a failed read has nothing to hide behind", async () => {
  const safe = new SafeAuditLogRepository(new ThrowingAuditLogRepository(), () => {});

  await assert.rejects(() => safe.findRecentByIdentity("id-1", 10));
});
