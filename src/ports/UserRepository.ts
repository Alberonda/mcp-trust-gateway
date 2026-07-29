import type { User } from "../domain/types.js";

export interface UserRepository {
  create(name: string): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByName(name: string): Promise<User | null>;
  listAll(): Promise<User[]>;
  /** Cascades to identities/user_roles/user_credentials referencing this user (see their
   *  ON DELETE CASCADE foreign keys) — removing a user removes their access entirely, not
   *  just their name. Throws if userId doesn't exist, since a silent no-op there would be
   *  a confusing way to fail. */
  remove(userId: string): Promise<void>;
}
