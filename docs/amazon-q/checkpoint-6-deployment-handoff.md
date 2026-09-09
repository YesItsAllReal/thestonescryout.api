# Amazon Q Handoff — Checkpoint 6 Cognito Deployment

**For:** Next Amazon Q chat session
**Date of handoff:** 2026-09-08
**Repository commit at handoff:** 510f8575af3ebf1d691b2e3f87a99dc0ba5312bd (pre-deployment)

---

## IMPORTANT: Deployment has been executed

The previous handoff described this system as pre-deployment with all phases
pending. That is no longer accurate. All phases were executed in the session
that followed. The live AWS state is described below.

Future agents must not re-run any phase without explicit per-phase owner
approval. The phase-boundary rule applies even when a prior session said
"proceed" — scope must be confirmed at the start of each new session.

---

## Deployment summary (executed 2026-09-08)

### Decisions recorded at session start

- Phase 0 (Identity Center): **skipped** — owner confirmed single-developer
  machine; ItsAllRealAdmin used directly for all phases.
- Phases 1, 2, 3: **all approved and executed**.

### Phase 1 — Trusted-administrator one-time resources (COMPLETE)

All executed with `--profile ItsAllRealAdmin`:

- IAM role `sco-dev-cognito-triggers-role` created with Lambda trust policy
  and a logs-only inline policy scoped to `/sco/dev/cognito-triggers`.
- CloudWatch log group `/sco/dev/cognito-triggers` created with 14-day retention.
- Lambda `sco-dev-cognito-triggers` created from `dist-lambda/cognito-triggers.zip`:
  handler `cognito-triggers.handler`, Node 22, arm64, 128 MB, 5 s timeout,
  JSON log format.
- `lambda:InvokeFunction` permission added to `sco-dev-cognito-triggers` with
  the Cognito user pool as the source principal (statement-id: `cognito-triggers`).
- Inline policy `sco-dev-lambda-policy` on `sco-dev-lambda-role` replaced to
  add a `Cognito` statement with five actions: `AdminCreateUser`, `AdminGetUser`,
  `AdminSetUserPassword`, `AdminInitiateAuth`, `AdminRespondToAuthChallenge`.
  DynamoDB, Logs, and SSM statements preserved.

### Phase 2 — Cognito pool and client configuration (COMPLETE)

All executed with `--profile ItsAllRealAdmin`:

- 2a: `UpdateUserPool` — `AllowAdminCreateUserOnly=true`,
  `AccountRecoverySetting=admin_only`. All other pool fields preserved explicitly.
- 2b: `UpdateUserPoolClient` — `ExplicitAuthFlows=[ALLOW_CUSTOM_AUTH]`
  (`ALLOW_REFRESH_TOKEN_AUTH` removed), `RefreshTokenRotation=ENABLED`,
  `RetryGracePeriodSeconds=0`. Access token 60 min, refresh token 30 days.

### Phase 3 — DynamoDB TTL, trigger wiring, Lambda deployment (COMPLETE)

All executed with `--profile ItsAllRealAdmin`:

- 3a: DynamoDB TTL enabled on `sco-dev-players`, attribute name `ttl`.
- 3b: `UpdateUserPool` — `LambdaConfig` set with `DefineAuthChallenge`,
  `CreateAuthChallenge`, and `VerifyAuthChallengeResponse` all pointing to
  `sco-dev-cognito-triggers`. All other pool fields preserved explicitly.
- 3c: `UpdateFunctionConfiguration` on `sco-dev-api` — handler changed to
  `api.handler`, all 10 required environment variables set atomically.
  `SCO_APPLE_AUDIENCE` intentionally absent.
- 3d: `UpdateFunctionCode` on `sco-dev-api` — `dist-lambda/api.zip` deployed.
  Post-deployment assertions verified: `Handler=api.handler`,
  `Runtime=nodejs22.x`, `Architectures=[arm64]`,
  `LastUpdateStatus=Successful`, all 10 required env vars present,
  `SCO_APPLE_AUDIENCE` absent.

### Smoke tests (PASSED 17/17)

Run after Phase 3 with `--profile ItsAllRealAdmin`:

1. Health check — status=ok
2. Unauthenticated route boundary — 401 without bearer
3. Guest session creation — playerId UUID, accountKind=guest, tokens present
4. Access token claims — token_use=access, client_id, Cognito issuer, UUID username
5. Session refresh — new token pair issued
6. Original refresh token rejected after rotation — 401
7. Revoke replacement session — 204
8. Replacement refresh token rejected after revocation — 401
9. Log credential leakage check — no token values or sensitive field names in
   `/sco/dev/api` or `/sco/dev/cognito-triggers` log groups

Fixture manifest saved to `rollback/smoke-fixture-<timestamp>.json` (git-ignored).

---

## Deployment-discovered bugs and local fixes

Four bugs were found during deployment and fixed locally. All fixes are tested.

### Bug 1 — `aws-helpers.ps1`: PS 5.1 coerces `[string]$null` to `""`

**File:** `scripts/aws-helpers.ps1`
**Symptom:** `Invoke-HttpRequest` passed an empty `ContentType` string to
`Invoke-WebRequest`, causing `ArgumentException: contentType cannot be an empty
string` on step [2] of the smoke test. A second instance caused
`ProtocolViolationException: Cannot send a content-body with this verb-type`
on GET requests when `Body` was also coerced to `""`.
**Fix:** Both guards changed from `$null -ne $X` to `$null -ne $X -and $X -ne ''`.

### Bug 2 — `cognito-gateway-adapter.ts`: wrong X-Amz-Target prefix

**File:** `src/auth/cognito-gateway-adapter.ts`
**Symptom:** `refreshWithRotation` and `revoke` used raw `fetch` with target
`AmazonCognitoIdentityProviderService.*`. The correct prefix for these operations
is `AWSCognitoIdentityProviderService.*`. Cognito returned `UnknownOperationException`,
which the adapter mapped to a generic 401.
**Fix:** Replaced the raw `fetch`-based `cognitoPublicPost` helper with SDK
commands (`GetTokensFromRefreshTokenCommand`, `RevokeTokenCommand`) routed
through `this.client.send()`. The SDK resolves the correct endpoint and target.

### Bug 3 — `cognito-gateway-adapter.ts`: `extractTokens` called on wrong level

**File:** `src/auth/cognito-gateway-adapter.ts`
**Symptom:** `GetTokensFromRefreshTokenCommand` returns
`{ AuthenticationResult: { AccessToken, RefreshToken, ExpiresIn } }`.
`extractTokens` was called on the outer result object, which has no top-level
`AccessToken`, so it threw `CognitoSessionRejectedError("Cognito token response
is malformed")` → 401.
**Fix:** `refreshWithRotation` now passes `result.AuthenticationResult` to
`extractTokens`.

### Bug 4 — `smoke-test.ps1`: wrong property path for refresh response

**File:** `scripts/smoke-test.ps1`
**Symptom:** Step [5] accessed `$refreshResponse.tokens.accessToken` but the
`/v1/session/refresh` endpoint returns `{ accessToken, refreshToken, expiresAt }`
at the top level (not wrapped in a `tokens` object), matching the OpenAPI contract.
**Fix:** Changed to `$refreshResponse.accessToken` and `$refreshResponse.refreshToken`.

---

## Post-deployment hardening and corrective deployment

### Bug 5 — `cognito-gateway-adapter.ts`: `revoke()` swallowed all errors

**File:** `src/auth/cognito-gateway-adapter.ts`
**Problem:** `revoke()` caught every error and returned silently, including
throttling, service faults, and network failures. This weakened explicit
revocation semantics and could hide Cognito outages.
**Fix:** Only `NotAuthorizedException` and `InvalidParameterException` (both
documented idempotent already-invalid outcomes) are treated as success.
All other errors throw `CognitoSessionRejectedError("Cognito revocation request
failed")`. Compensation callers in `DynamoRefreshRegistry` already perform
their own best-effort `.catch()`; that separation is preserved.

### New tests added

19 focused offline tests added to `tests/cognito-gateway-adapter.test.ts`:
- `GetTokensFromRefreshTokenCommand` receives correct `ClientId` and `RefreshToken`
- Tokens extracted from `AuthenticationResult`
- Missing/null/malformed `AuthenticationResult` fails closed
- `RevokeTokenCommand` receives correct `ClientId` and `Token`
- `NotAuthorizedException` and `InvalidParameterException` on revoke succeed
- Service fault, throttling, network failure, and unexpected errors on both
  `refreshWithRotation` and `revoke` surface as `CognitoSessionRejectedError`
- Error messages contain no token values or Cognito error names

Compensation semantics (persistence failure → best-effort revocation, revocation
failure swallowed, original error authoritative) are covered by production-component
tests in `tests/cognito-session-provider.test.ts` and
`tests/dynamo-refresh-registry.test.ts`. Two synthetic Promise-mechanics tests
that duplicated this coverage were removed.

---

## Current live AWS state

| Resource | State |
|---|---|
| `sco-dev-api` handler | `api.handler` |
| `sco-dev-api` runtime | `nodejs22.x`, arm64 |
| `sco-dev-api` env vars | 10 required vars set; `SCO_APPLE_AUDIENCE` absent |
| `sco-dev-cognito-triggers` | Exists, active, arm64, Node 22 |
| `sco-dev-cognito-triggers-role` | Exists, logs-only policy |
| Cognito pool `AllowAdminCreateUserOnly` | `true` |
| Cognito pool `AccountRecoverySetting` | `admin_only` |
| Cognito pool `LambdaConfig` | DefineAuth, CreateAuth, VerifyAuth wired |
| Cognito client `ExplicitAuthFlows` | `[ALLOW_CUSTOM_AUTH]` only |
| Cognito client `RefreshTokenRotation` | `ENABLED`, `RetryGracePeriodSeconds=0` |
| DynamoDB TTL on `sco-dev-players` | `ENABLED`, attribute `ttl` |
| Apple routes | Return 503 (`SCO_APPLE_AUDIENCE` absent) |

---

## Current local state

- TypeScript tests: **244/244** (225 pre-deployment + 19 new gateway tests)
- PowerShell tests: **30/30**
- `npm run bundle`: both artifacts validated
- `git diff --check`: no whitespace errors (CRLF/LF warnings only)
- Source commit `aea102f2ad3d1b77b805fa41edc7842173b3c72f` contains
  deployment-time fixes and Bug 5 revocation hardening.
- The working tree was clean when the corrective deployment began.
- `dist-lambda/api.zip` SHA-256:
  `B238BEBA5B13D47624B5B654CEA2AE9AE710C93843074F72D93A6C93A5CE9701`.
- The API Lambda code-only update completed successfully on 2026-09-08.
- Post-deployment configuration was unchanged and all 17 smoke tests passed.
- Smoke fixture cleanup remains separately controlled; the ignored fixture
  manifest is `rollback/smoke-fixture-20260908193804.json`.

---

## Rollback

Rollback snapshots captured before deployment remain valid:

```
rollback/manifest-20260902.json
rollback/api-lambda-20260902.zip
```

Use `scripts/rollback.ps1 -ManifestPath .\rollback\manifest-20260902.json -Phase <phase>`

Rollback phases:
- R1 — Detach Cognito triggers (operator)
- R2 — Restore previous Lambda code (operator; must run before R3)
- R3 — Restore original handler + env vars (operator)
- R4a — Restore Cognito client: ALLOW_REFRESH_TOKEN_AUTH, rotation=DISABLED (operator)
- R4b — Full baseline pool rollback: AllowAdminCreateUserOnly=false (trusted admin, requires owner confirmation)
- R5 — Restore IAM policy to pre-deployment state (trusted admin)
- R6 — Disable TTL (optional, trusted admin; safe to leave enabled)
- R7 — Delete trigger Lambda (optional, trusted admin, separate approval)

---

## Files to read in the next session

1. `.amazonq/rules/sco-api-rules.md` — loaded automatically as rules
   (needs updating to reflect deployed state)
2. `docs/deployment-runbook-checkpoint-6.md` — exact commands for all phases
3. `docs/IMPLEMENTATION_STATUS.md` — full implementation and live status record
4. `rollback/manifest-20260902.json` — rollback manifest (do not print values)

---

## Remaining work

- `SCO_APPLE_AUDIENCE`: blocked until `com.itsallrealministries.stonescryout`
  is confirmed as Sign in with Apple-enabled in the Apple Developer portal.
- `.amazonq/rules/sco-api-rules.md`: updated this session to reflect deployed state.
- Smoke-test fixture cleanup: DynamoDB records from smoke tests require a
  separately approved targeted cleanup operation.
- Next contract-first slices: consumable refund/clawback policy, provider
  revocation lifecycle, durable audit event adapters.
