// scripts/validate-artifact.mjs
// Validates that each Lambda deployment artifact:
//   1. Contains the expected handler file (api.cjs or cognito-triggers.cjs) and package.json.
//   2. Can be loaded in a child Node process with complete dummy environment variables.
//   3. Exports a function named "handler" -- verified by the child process itself.
//
// Every unexpected error (syntax, missing module, cold-start failure) causes a
// nonzero exit. With complete dummy env vars the API bundle makes no network call.
//
// Handler names verified:
//   api.zip              -> api.cjs      -> api.handler
//   cognito-triggers.zip -> cognito-triggers.cjs -> cognito-triggers.handler
//   account-deletion-worker.zip -> account-deletion-worker.cjs -> account-deletion-worker.handler
//
// Usage:
//   node scripts/validate-artifact.mjs

import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const root = join(__dirname, "..");

// Dummy environment variables that satisfy loadRuntimeConfiguration without
// making any network call. SCO_APPLE_AUDIENCE is intentionally absent to
// exercise the optional-audience code path.
const DUMMY_ENV = {
  SCO_ENVIRONMENT:              "development",
  SCO_PLAYER_TABLE_NAME:        "validate-only",
  SCO_TOKEN_ISSUER:             "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ValidatePool",
  SCO_TOKEN_AUDIENCE:           "validate-client",
  SCO_COGNITO_USER_POOL_ID:     "us-east-1_ValidatePool",
  SCO_COGNITO_CLIENT_ID:        "validate-client",
  SCO_REFRESH_LIFETIME_SECONDS: "2592000",
  SCO_GUEST_STARTING_COINS:     "200",
  SCO_GUEST_STARTING_GEMS:      "20",
  SCO_GUEST_STARTING_ENERGY:    "200",
};

// Artifacts: [zipPath, expectedHandlerFile, exportedName]
const artifacts = [
  [join(root, "dist-lambda", "api.zip"),              "api.cjs",              "handler"],
  [join(root, "dist-lambda", "cognito-triggers.zip"), "cognito-triggers.cjs", "handler"],
  [join(root, "dist-lambda", "account-deletion-worker.zip"), "account-deletion-worker.cjs", "handler"],
];

let allPassed = true;

for (const [zipPath, handlerFile, exportName] of artifacts) {
  const tmpDir = await mkdtemp(join(tmpdir(), "sco-validate-"));
  try {
    await extractZip(zipPath, tmpDir);

    // 1. Check expected files are present.
    const files = await readdir(tmpDir);
    if (!files.includes(handlerFile)) {
      console.error(`FAIL ${basename(zipPath)}: expected ${handlerFile} in zip, found: ${files.join(", ")}`);
      allPassed = false;
      continue;
    }

    // 2. Check package.json is present.
    if (!files.includes("package.json")) {
      console.error(`FAIL ${basename(zipPath)}: missing package.json`);
      allPassed = false;
      continue;
    }

    // 3. Write a small assertion script into the temp directory.
    //    It imports the bundle, asserts the export is a function, and exits
    //    nonzero on any exception — including unexpected cold-start errors.
    const bundleUrl = join(tmpDir, handlerFile);
    const assertScript = join(tmpDir, "_assert.cjs");
    await writeFile(assertScript, `
const mod = require(${JSON.stringify(bundleUrl)});
if (typeof mod.handler !== "function") {
  process.stderr.write("ASSERT_FAIL: handler is " + typeof mod.handler + "\\n");
  process.exit(2);
}
process.stdout.write("ASSERT_PASS\\n");
`.trimStart(), "utf8");

    // 4. Run the assertion script in a child process with dummy env vars.
    //    Any exception — including unexpected runtime errors — causes a nonzero exit.
    let result;
    try {
      result = await exec(process.execPath, [assertScript], {
        timeout: 15_000,
        env: { ...DUMMY_ENV },
      });
    } catch (err) {
      // Child exited nonzero or timed out — this is a hard failure.
      const stderr = (err.stderr ?? "").trim();
      const stdout = (err.stdout ?? "").trim();
      console.error(`FAIL ${basename(zipPath)}: handler assertion failed`);
      if (stderr) console.error(`  stderr: ${stderr}`);
      if (stdout) console.error(`  stdout: ${stdout}`);
      allPassed = false;
      continue;
    }

    if (!result.stdout.includes("ASSERT_PASS")) {
      console.error(`FAIL ${basename(zipPath)}: assertion script did not emit ASSERT_PASS`);
      allPassed = false;
      continue;
    }

    console.log(`PASS ${basename(zipPath)}: ${handlerFile} exports "${exportName}" as a function`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

if (!allPassed) {
  console.error("Artifact validation failed. Do not deploy.");
  process.exit(1);
}

console.log("All artifacts validated.");

async function extractZip(zipPath, destDir) {
  await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ]);
}
