// scripts/build-lambda.mjs
// Produces two self-contained ESM bundles under dist-lambda/:
//   api.mjs              — API Lambda entry point
//   cognito-triggers.mjs — Cognito trigger dispatcher
//
// Usage:
//   node scripts/build-lambda.mjs
//
// All runtime dependencies (jose, AWS SDK) are bundled. No node_modules
// directory is required in the deployment artifact.

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const root = join(__dirname, "..");
const outDir = join(root, "dist-lambda");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  // Use CJS format so AWS SDK CJS packages (which use require() internally)
  // work correctly. Lambda Node 22 handles .cjs files as CommonJS.
  format: "cjs",
  sourcemap: true,
  // Mark all Node built-ins as external — always available in the Lambda runtime.
  external: ["node:*"],
  logOverride: { "ignored-bare-specifier": "silent" },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [join(root, "src", "lambda", "index.ts")],
    outfile: join(outDir, "api.cjs"),
  }),
  build({
    ...shared,
    entryPoints: [join(root, "src", "lambda", "cognito-triggers.ts")],
    outfile: join(outDir, "cognito-triggers.cjs"),
  }),
]);

console.log("Lambda bundles written to dist-lambda/");
console.log("  api.cjs");
console.log("  cognito-triggers.cjs");
