import { createHash } from "node:crypto";

import type { InstallationIdHasher } from "./guest-session-service.js";

export class Sha256InstallationIdHasher implements InstallationIdHasher {
  public hash(installationId: string): string {
    return createHash("sha256").update(installationId, "utf8").digest("hex");
  }
}
