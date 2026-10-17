import type { Repository } from "@everything/persistence/repository";
import type { StoredKey } from "../model/stored-key.js";
import type { SshKeyScope } from "../model/ssh-key-scope.js";

/** Internal SSH synchronization uses an explicit installation scope independent of browser sessions. */
export interface SshKeyRepository extends Repository<StoredKey, SshKeyScope> {}
