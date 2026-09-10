import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { SignedDocumentVerifier } from "./content-service.js";

export class Ed25519DocumentVerifier implements SignedDocumentVerifier {
  private readonly keys = new Map<string, KeyObject>();

  public constructor(publicKeys: Readonly<Record<string, string>>) {
    const entries = Object.entries(publicKeys);
    if (entries.length < 1 || entries.length > 16) throw new Error("content signing keys are not configured");
    for (const [keyId, encodedKey] of entries) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId) || encodedKey.trim() === "") throw new Error("content signing key configuration is invalid");
      try {
        const key = createPublicKey(encodedKey);
        if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
        this.keys.set(keyId, key);
      } catch {
        throw new Error("content signing key configuration is invalid");
      }
    }
  }

  public async verify(input: {
    readonly document: unknown;
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly signature: string;
  }): Promise<boolean> {
    if (input.algorithm !== "ed25519" || !/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return false;
    const key = this.keys.get(input.keyId);
    if (key === undefined) return false;
    try {
      const document = canonicalJson(input.document);
      const signature = Buffer.from(input.signature, "base64url");
      return signature.length === 64 && verify(null, Buffer.from(document, "utf8"), key, signature);
    } catch {
      return false;
    }
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, 0, { nodes: 0 });
}

function canonicalValue(value: unknown, depth: number, state: { nodes: number }): string {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 100_000) throw new Error("document exceeds canonicalization limits");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("document contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, depth + 1, state)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const fields: string[] = [];
    for (const key of keys) {
      const field = object[key];
      if (field === undefined || typeof field === "function" || typeof field === "symbol" || typeof field === "bigint") {
        throw new Error("document contains an unsupported value");
      }
      fields.push(`${JSON.stringify(key)}:${canonicalValue(field, depth + 1, state)}`);
    }
    return `{${fields.join(",")}}`;
  }
  throw new Error("document contains an unsupported value");
}
