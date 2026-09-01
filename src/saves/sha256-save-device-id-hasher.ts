import { createHash } from "node:crypto";

import type { SaveDeviceIdHasher } from "./save-service.js";

export class Sha256SaveDeviceIdHasher implements SaveDeviceIdHasher {
  public hash(deviceId: string): string {
    return createHash("sha256").update(deviceId, "utf8").digest("hex");
  }
}
