// scripts/package-lambda.mjs
// Packages the esbuild bundles into deployment zips under dist-lambda/:
//   api.zip              — contains api.mjs + api.mjs.map + package.json
//   cognito-triggers.zip — contains cognito-triggers.mjs + .map + package.json
//
// Usage:
//   node scripts/package-lambda.mjs
//
// Run after build-lambda.mjs.

import { writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const root = join(__dirname, "..");
const outDir = join(root, "dist-lambda");

// ESM marker not needed for CJS bundles — Lambda handles .cjs as CommonJS.
// We write an empty package.json to satisfy any tooling that expects one.
const pkgJson = JSON.stringify({}, null, 2);
await writeFile(join(outDir, "package.json"), pkgJson, "utf8");

const bundles = [
  { name: "api",              files: ["api.cjs", "api.cjs.map", "package.json"] },
  { name: "cognito-triggers", files: ["cognito-triggers.cjs", "cognito-triggers.cjs.map", "package.json"] },
];

for (const { name, files } of bundles) {
  const zipPath = join(outDir, `${name}.zip`);
  await rm(zipPath, { force: true });

  const fileList = files.map((f) => `'${join(outDir, f)}'`).join(", ");
  await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Compress-Archive -LiteralPath ${fileList} -DestinationPath '${zipPath}' -Force`,
  ]);

  console.log(`Packaged dist-lambda/${name}.zip`);
}

console.log("Packaging complete.");
