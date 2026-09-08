// scripts/validate-ps1.mjs
// Parses every scripts/**/*.ps1 file using the PowerShell language parser.
// Fails on any parse error. Network-free. Compatible with Windows PowerShell 5.1.
//
// Usage:
//   node scripts/validate-ps1.mjs

import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = __dirname;

// Find all .ps1 files under scripts/.
const entries = await readdir(scriptsDir);
const ps1Files = entries
  .filter((f) => f.endsWith(".ps1"))
  .map((f) => join(scriptsDir, f));

if (ps1Files.length === 0) {
  console.log("No .ps1 files found.");
  process.exit(0);
}

// PowerShell inline script: parse each file and report errors.
// Uses [System.Management.Automation.Language.Parser]::ParseFile.
// Outputs "OK:<path>" or "ERR:<path>:<line>:<col>:<message>" per file.
// Never invokes AWS or any network call.
const psLines = ps1Files.map((p) => {
  // Escape single quotes in path for PowerShell single-quoted string.
  const escaped = p.replace(/'/g, "''");
  return `
$errors = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
  foreach ($e in $errors) {
    Write-Output "ERR:${escaped}:$($e.Extent.StartLineNumber):$($e.Extent.StartColumnNumber):$($e.Message)"
  }
} else {
  Write-Output "OK:${escaped}"
}`;
});

const psScript = psLines.join("\n");

let result;
try {
  result = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", psScript,
  ], { timeout: 30_000 });
} catch (err) {
  console.error("PowerShell parser invocation failed:", err.message);
  process.exit(1);
}

const lines = result.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
let anyError = false;

for (const line of lines) {
  if (line.startsWith("OK:")) {
    const file = line.slice(3);
    console.log(`PASS ${file}`);
  } else if (line.startsWith("ERR:")) {
    // Format: ERR:<path>:<line>:<col>:<message>
    // Split on first four colons only (message may contain colons).
    const rest = line.slice(4);
    const parts = rest.split(":");
    // On Windows paths start with drive letter: C:\... so parts[0] is drive, parts[1] is rest of path.
    // Reconstruct: path = parts[0]+":"+parts[1], line = parts[2], col = parts[3], msg = rest of parts.
    let filePath, lineNum, colNum, msg;
    if (parts.length >= 5 && parts[0].length === 1) {
      filePath = parts[0] + ":" + parts[1];
      lineNum  = parts[2];
      colNum   = parts[3];
      msg      = parts.slice(4).join(":");
    } else {
      filePath = parts[0];
      lineNum  = parts[1];
      colNum   = parts[2];
      msg      = parts.slice(3).join(":");
    }
    console.error(`FAIL ${filePath} line ${lineNum} col ${colNum}: ${msg.trim()}`);
    anyError = true;
  } else {
    // Unexpected output -- treat as informational.
    console.log(line);
  }
}

if (anyError) {
  console.error("PowerShell syntax validation failed.");
  process.exit(1);
}

console.log(`All ${ps1Files.length} PowerShell file(s) parsed successfully.`);
