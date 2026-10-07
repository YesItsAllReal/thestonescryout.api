// Runs the offline PowerShell test suite with the platform's PowerShell host.
// GitHub's Ubuntu runners expose PowerShell 7 as `pwsh`; supported Windows
// development machines expose Windows PowerShell as `powershell.exe`.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const result = spawnSync(powershell, [
  "-NoProfile",
  "-NonInteractive",
  "-File",
  join(scriptsDir, "test-scripts.ps1"),
], { stdio: "inherit" });

if (result.error !== undefined) {
  console.error(`PowerShell test invocation failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
