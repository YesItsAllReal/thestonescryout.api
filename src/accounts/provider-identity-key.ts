import { createHash } from "node:crypto";

export interface ProviderIdentityKey {
  readonly pk: string;
  readonly sk: "PLAYER";
  readonly subjectHash: string;
}

export function providerIdentityKey(issuer: string, subject: string): ProviderIdentityKey {
  const normalizedIssuer = normalizeIssuer(issuer);
  if (subject.length < 1 || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error("provider subject is invalid");
  }
  const subjectHash = sha256(subject);
  return { pk: `PROVIDER#${sha256(normalizedIssuer)}#${subjectHash}`, sk: "PLAYER", subjectHash };
}

function normalizeIssuer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("provider issuer is invalid"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("provider issuer is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
