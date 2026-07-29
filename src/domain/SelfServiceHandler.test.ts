import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionRepository } from "../ports/PermissionRepository.js";
import type { NewUpstreamServer, UpstreamServerRepository } from "../ports/UpstreamServerRepository.js";
import type { EncryptedUpstreamCredential, UpstreamServer } from "./types.js";
import type { UserCredentialRepository } from "../ports/UserCredentialRepository.js";
import { AesGcmCredentialVault } from "../adapters/security/CredentialVault.js";
import { SelfServiceHandler } from "./SelfServiceHandler.js";

const USER_ID = "user-1";

class FakePermissionRepository implements PermissionRepository {
  constructor(private readonly accessibleServerIds: string[] = []) {}
  async isCallAllowed(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async findAccessibleServerIds(): Promise<string[]> {
    return this.accessibleServerIds;
  }
  async findAllowedToolNames(): Promise<never> {
    throw new Error("not used in these tests");
  }
}

class FakeUpstreamServerRepository implements UpstreamServerRepository {
  constructor(private readonly servers: readonly UpstreamServer[]) {}
  async findByName(name: string): Promise<UpstreamServer | null> {
    return this.servers.find((s) => s.name === name) ?? null;
  }
  async findManyByIds(): Promise<UpstreamServer[]> {
    throw new Error("not used in these tests");
  }
  async findAll(): Promise<UpstreamServer[]> {
    return [...this.servers];
  }
  async create(_server: NewUpstreamServer): Promise<UpstreamServer> {
    throw new Error("not used in these tests");
  }
}

class FakeUserCredentialRepository implements UserCredentialRepository {
  public readonly upserted: { userId: string; serverId: string; credential: EncryptedUpstreamCredential }[] = [];
  constructor(private readonly existing: ReadonlySet<string> = new Set()) {}
  async find(userId: string, serverId: string): Promise<EncryptedUpstreamCredential | null> {
    return this.existing.has(serverId) ? ({} as EncryptedUpstreamCredential) : null;
  }
  async upsert(userId: string, serverId: string, credential: EncryptedUpstreamCredential): Promise<void> {
    this.upserted.push({ userId, serverId, credential });
  }
  async remove(): Promise<void> {}
}

const server = (id: string, name: string): UpstreamServer => ({ id, name, command: "irrelevant", args: [], requiresRelay: false });
const vault = new AesGcmCredentialVault(Buffer.alloc(32, 1));

test("listServices marks a server the user has no permission for as not_permitted", async () => {
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository([]),
    new FakeUpstreamServerRepository([server("s1", "sonarqube")]),
    new FakeUserCredentialRepository(),
    vault,
  );

  const services = await handler.listServices();

  assert.deepEqual(services, [{ server: "sonarqube", status: "not_permitted" }]);
});

test("listServices marks a permitted server with no stored credential as needs_credential", async () => {
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository(["s1"]),
    new FakeUpstreamServerRepository([server("s1", "sonarqube")]),
    new FakeUserCredentialRepository(),
    vault,
  );

  const services = await handler.listServices();

  assert.deepEqual(services, [{ server: "sonarqube", status: "needs_credential" }]);
});

test("listServices marks a permitted server with a stored credential as ready", async () => {
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository(["s1"]),
    new FakeUpstreamServerRepository([server("s1", "sonarqube")]),
    new FakeUserCredentialRepository(new Set(["s1"])),
    vault,
  );

  const services = await handler.listServices();

  assert.deepEqual(services, [{ server: "sonarqube", status: "ready" }]);
});

test("registerMyCredential refuses to set a credential for a server the user has no permission on", async () => {
  const credentials = new FakeUserCredentialRepository();
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository([]), // no permission on "s1"
    new FakeUpstreamServerRepository([server("s1", "sonarqube")]),
    credentials,
    vault,
  );

  const result = await handler.registerMyCredential("sonarqube", { TOKEN: "abc" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /don't have permission/);
  assert.equal(credentials.upserted.length, 0, "must never store a credential for a server the user isn't permitted on");
});

test("registerMyCredential succeeds for a server the user IS permitted on, encrypting the given env", async () => {
  const credentials = new FakeUserCredentialRepository();
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository(["s1"]),
    new FakeUpstreamServerRepository([server("s1", "sonarqube")]),
    credentials,
    vault,
  );

  const result = await handler.registerMyCredential("sonarqube", { TOKEN: "abc" });

  assert.equal(result.isError, undefined);
  assert.equal(credentials.upserted.length, 1);
  assert.equal(credentials.upserted[0].userId, USER_ID);
  assert.equal(credentials.upserted[0].serverId, "s1");
  assert.equal(vault.decrypt(credentials.upserted[0].credential), JSON.stringify({ TOKEN: "abc" }));
});

test("registerMyCredential rejects an unknown server name", async () => {
  const handler = new SelfServiceHandler(
    USER_ID,
    new FakePermissionRepository([]),
    new FakeUpstreamServerRepository([]),
    new FakeUserCredentialRepository(),
    vault,
  );

  const result = await handler.registerMyCredential("does-not-exist", { TOKEN: "abc" });

  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /Unknown server/);
});
