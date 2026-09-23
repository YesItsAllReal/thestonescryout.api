# Stones Cry Out API — Amazon Q Agent Rules

## Project identity

- Repository: thestonescryout.api (this repo)
- Adjacent repos: thestonescryout.ios, thestonescryout.android, thestonescryout.docs
- Publishing company domain: itsallreal.org
- iOS bundle ID: com.itsallrealministries.stonescryout
- AWS account: 598628878271, region us-east-1
- All SCO resources use the sco-dev- prefix and are isolated from bmerge-* and itsallreal.org

## AWS credentials rule

- Administrator profile: ItsAllRealAdmin (arn:aws:iam::598628878271:user/ItsAllRealAdmin)
- Use --profile ItsAllRealAdmin for all trusted-administrator AWS commands
- bmerge profile resolves to the account root — never use it for mutations
- Identity Center (sco-dev profile) is the planned operator credential; not yet configured
- Never use root credentials for any mutation

## Deployment state as of 2026-09-08

Checkpoint 6 Phases 1–3 were deployed on 2026-09-08. Phase 0 (Identity Center)
was skipped by owner decision; ItsAllRealAdmin was used directly for all phases.

### Live AWS state

- Lambda sco-dev-api: handler = api.handler, concrete Cognito + DynamoDB adapters
- Lambda sco-dev-cognito-triggers: EXISTS — arm64, Node 22, 128 MB, 5 s
- IAM role sco-dev-cognito-triggers-role: EXISTS — Lambda trust, logs-only policy
- Cognito pool: AllowAdminCreateUserOnly=true, AccountRecoverySetting=admin_only
- Cognito pool LambdaConfig: DefineAuth, CreateAuth, VerifyAuth wired to sco-dev-cognito-triggers
- Cognito client: ExplicitAuthFlows=[ALLOW_CUSTOM_AUTH], RefreshTokenRotation=ENABLED,
  RetryGracePeriodSeconds=0
- DynamoDB sco-dev-players: TTL ENABLED on attribute ttl
- sco-dev-lambda-role policy: includes five Cognito admin actions
- SCO_APPLE_AUDIENCE: NOT SET — Apple routes still return 503 in the live Lambda
- Apple portal gate: SATISFIED 2026-09-22. The owner confirmed
  com.itsallrealministries.stonescryout is Sign in with Apple-enabled and is the
  primary App ID. This confirmation does not itself authorize an AWS mutation.

### Source and deployment boundary

- Post-deployment revocation hardening was deployed to sco-dev-api from commit
  aea102f on 2026-09-08 and passed all 17 smoke tests.
- Later local Checkpoint 6 work is not live merely because it exists or passes
  tests. Read `docs/IMPLEMENTATION_STATUS.md` and inspect Git before proposing a
  deployment; never claim that the live Lambda matches the current HEAD without
  a fresh read-only comparison.
- Current local validation baseline as of 2026-09-10: 358/358 TypeScript tests,
  30/30 PowerShell tests, valid OpenAPI, and both Lambda artifacts validated.
- Locally implemented but disabled/unapproved live capabilities include account
  deletion, account-link reconciliation, economy/entitlement reads, and other
  routes explicitly identified in `docs/IMPLEMENTATION_STATUS.md`.

## Authorization rules — read carefully before every session

### Never infer authorization from conversational language

Words like "continue", "proceed", "go ahead", or "keep going" do not authorize
AWS mutations. Every AWS mutation requires:
1. An explicit statement of the exact resources and actions to be changed.
2. Fresh, explicit owner approval for that bounded phase in the current session.

Read-only approval (e.g. "run the preflight checks") does not authorize mutations.

### Phase boundaries are hard stops

Each deployment phase is a separate authorization unit. Approval of one phase
does not authorize any other phase. Do not chain phases without re-asking.

### Never skip approved security boundaries without asking

Identity Center was skipped by explicit owner decision for a single-developer
machine. Do not skip it again in a future session without asking the owner first.
Do not create both an Identity Center operator and a long-lived IAM user.

### No diagnostic files containing tokens or credential responses

Never write tokens, credential responses, AWS API responses containing sensitive
fields, or challenge values to any file — including temporary files, rollback
directories, or scratch files. Temporary diagnostic output must remain in memory
and be redacted before any summary, log, or chat message.

### No credentials or tokens anywhere

No credentials, tokens, secrets, or sensitive AWS response values ever enter:
- Source code or test fixtures
- Repository files of any kind
- Terminal output summaries
- Log events
- Chat messages

## Key resource identifiers

Cognito user pool:   us-east-1_SDheytSys
Cognito app client:  5vkq6jm3vbulh6v8n4f565benr (sco-dev-mobile, no secret)
API Lambda:          sco-dev-api
API endpoint:        https://q0zoa13ye9.execute-api.us-east-1.amazonaws.com
DynamoDB table:      sco-dev-players (pk+sk, on-demand, no PITR)
Lambda role:         sco-dev-lambda-role (inline policy: sco-dev-lambda-policy)
Cognito triggers:    sco-dev-cognito-triggers (EXISTS — created in Phase 1)
Trigger role:        sco-dev-cognito-triggers-role (EXISTS — created in Phase 1)
CloudFront:          E1WW3HKF9297IA — https://d34mfol19lzvcv.cloudfront.net
S3 content bucket:   sco-dev-content-598628878271

## Approved economy values (trusted server config, never from client)

SCO_GUEST_STARTING_COINS=200
SCO_GUEST_STARTING_GEMS=20
SCO_GUEST_STARTING_ENERGY=200
energyCap=200 (for future signed remote configuration)

## Apple authentication gate

The owner confirmed on 2026-09-22 that
com.itsallrealministries.stonescryout is Sign in with Apple-enabled and is the
primary App ID. That exact value is the approved native iOS audience. Apple
routes still return 503 because the live Lambda does not have
SCO_APPLE_AUDIENCE set. Setting it requires a fresh, explicitly approved AWS
configuration/deployment phase; portal confirmation alone is not approval.

## Architecture rules

- Domain services must remain independent of AWS SDK types
- No credentials, tokens, or secrets ever enter logs, responses, or repository files
- All AWS CLI calls in scripts use Invoke-AwsChecked (scripts/aws-helpers.ps1)
  which throws on nonzero $LASTEXITCODE — never use bare & aws in deployment scripts
- Lambda artifacts are CJS bundles produced by npm run bundle (esbuild)
- npm run check must pass before any deployment (current baseline: 358 TS + 30 PS tests + lint)
- npm run bundle must pass (both artifacts validated) before any Lambda deployment

## Deployment script locations

scripts/aws-helpers.ps1       shared PS helpers (Invoke-AwsChecked, Invoke-AwsRetryable, ConvertTo-LambdaEnvArg)
scripts/smoke-test.ps1        post-deployment smoke tests (PS 5.1 compatible, tokens never printed)
scripts/rollback.ps1          rollback executor (requires -ManifestPath, validates SHA-256)
scripts/build-lambda.mjs      esbuild CJS bundler
scripts/package-lambda.mjs    zip packager
scripts/validate-artifact.mjs artifact validator (child process, asserts handler is a function)
scripts/validate-ps1.mjs      PowerShell syntax checker (wired into npm run check)
scripts/test-scripts.ps1      offline PS tests (30 tests, no AWS calls)

## What must never happen

- Do not commit rollback/ files (git-ignored)
- Do not print token values, credentials, env variable values, or full policy JSON to chat
- Do not perform AWS mutations without explicit per-phase owner approval
- Do not infer authorization from "continue", "proceed", or similar conversational language
- Do not enable Identity Center, create IAM resources, or deploy code without approval
- Do not use bmerge profile for mutations
- Do not create both an Identity Center operator AND a long-lived sco-dev-operator IAM user
- Do not change the iOS bundle ID, Apple audience, or economy values without owner approval
- Do not write tokens, credential responses, or challenge values to any file
- Do not redeploy Lambda without committing the working tree locally first
