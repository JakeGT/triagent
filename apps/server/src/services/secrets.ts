// Secrets at rest: GitHub credentials, webhook secrets and model keys are encrypted with AES-256-GCM
// under a key that never touches the database (TRIAGENT_SECRETS_KEY_FILE).
//
// Each secret is bound to where it belongs (workspace, project and name) as authenticated data, so a
// ciphertext copied into another workspace's row, or another field, fails to decrypt instead of
// silently working. Secrets are write-only through the API: responses only ever say whether one is set,
// its last few characters, and who set it when.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ApiError } from "../errors.ts";
import { now } from "../security.ts";
import type { Repos, SecretRecord } from "../store/types.ts";

const VERSION = "v1";

export interface SecretScope {
    workspaceId: string | null;
    projectId: string | null;
}

export interface SecretView {
    name: string;
    set: boolean;
    hint: string | null;
    setBy: string | null;
    setAt: string | null;
}

export class SecretBox {
    private readonly key: Buffer;
    /** Identifies the key, so a later rotation knows which secrets still use the old one. */
    readonly keyId: string;
    readonly ephemeral: boolean;

    constructor(key: Buffer | null) {
        this.ephemeral = key === null;
        this.key = key ?? randomBytes(32);
        if (this.key.length !== 32) throw new Error("The secrets key must be 32 bytes.");
        this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 8);
    }

    private aad(scope: SecretScope, name: string): Buffer {
        return Buffer.from(`${scope.workspaceId ?? "-"}|${scope.projectId ?? "-"}|${name}`);
    }

    seal(value: string, scope: SecretScope, name: string): string {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(this.aad(scope, name));
        const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return [VERSION, this.keyId, nonce.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
    }

    open(sealed: string, scope: SecretScope, name: string): string {
        const [version, keyId, nonce, ct, tag] = sealed.split(".");
        if (version !== VERSION || !nonce || !ct || !tag) throw new Error("Unrecognised secret format.");
        if (keyId !== this.keyId)
            throw new Error(
                `This secret was stored with key ${keyId}, but the server has key ${this.keyId}. Restore the old key, or set the secret again.`,
            );
        const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "base64"));
        decipher.setAAD(this.aad(scope, name));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
    }
}

/** The last four characters, enough to tell two keys apart without revealing either. */
const hintOf = (value: string) => (value.length >= 12 ? `…${value.slice(-4)}` : "…");

export function viewOf(name: string, record: SecretRecord | null): SecretView {
    return { name, set: Boolean(record), hint: record?.hint ?? null, setBy: record?.setBy ?? null, setAt: record?.setAt ?? null };
}

export class Secrets {
    private readonly box: SecretBox;

    constructor(box: SecretBox) {
        this.box = box;
    }

    async set(tx: Repos, scope: SecretScope, name: string, value: string, setBy: string): Promise<SecretView> {
        const record: SecretRecord = {
            ...scope,
            name,
            sealed: this.box.seal(value, scope, name),
            hint: hintOf(value),
            setBy,
            setAt: now(),
        };
        await tx.secrets.put(record);
        return viewOf(name, record);
    }

    async clear(tx: Repos, scope: SecretScope, name: string): Promise<void> {
        await tx.secrets.delete(scope.workspaceId, scope.projectId, name);
    }

    async view(repos: Repos, scope: SecretScope, name: string): Promise<SecretView> {
        return viewOf(name, await repos.secrets.get(scope.workspaceId, scope.projectId, name));
    }

    /** The secret's value, for the code that uses it. Never put the result in a response or a log. */
    async reveal(repos: Repos, scope: SecretScope, name: string): Promise<string | null> {
        const record = await repos.secrets.get(scope.workspaceId, scope.projectId, name);
        if (!record) return null;
        try {
            return this.box.open(record.sealed, scope, name);
        } catch (err) {
            throw new ApiError(500, `The stored ${name} can't be decrypted: ${(err as Error).message}`);
        }
    }
}
