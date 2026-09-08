# Amazon Q handoff: Cognito Option 1 Lite

Use the prompt below in Amazon Q Developer. It is deliberately split into an
inspection phase and an implementation phase. Phase A is read-only and must stop
for owner approval before any AWS or repository mutation.

## Prompt

Continue Stones Cry Out Checkpoint 6 Cognito integration using the approved
**Option 1 Lite** design. Read `../AGENTS.md`, `./AGENTS.md`, `./README.md`,
`docs/authentication-token-contract.md`, `docs/IMPLEMENTATION_STATUS.md`, ADR
`docs/adr/0001-aws-serverless-dynamodb.md`, and the relevant source/tests under
`src/auth`, `src/app`, and `tests` before proposing changes.

Known environment:

- AWS account `598628878271`
- Region `us-east-1`
- CLI profile `bmerge`
- User pool `sco-dev-users`, ID `us-east-1_SDheytSys`
- App client `sco-dev-mobile`, ID `5vkq6jm3vbulh6v8n4f565benr`, no secret
- API Lambda `sco-dev-api`
- Player table `sco-dev-players`
- All work must remain in the `sco-dev-*` and `/sco/dev/*` namespaces.

Cost is a hard requirement. Do not enable Cognito Essentials/Plus, V2/V3
pre-token-generation access-token customization, advanced security, WAF, new
paid services, or provision staging/production resources. Option 1 Lite uses
Cognito standard access-token claims and an authoritative DynamoDB lookup; it
does not add custom `player_id` or `session_kind` access-token claims.

### Phase A — read-only inspection and plan

Use read-only AWS commands to verify the active account/Region, user-pool feature
plan, LambdaConfig, app-client auth flows, refresh-token rotation settings,
deletion protection, and relevant IAM permissions. Redact credentials and token
values. Do not create or update anything. Report:

1. Every current value relevant to the proposed change.
2. Whether refresh-token rotation and `GetTokensFromRefreshToken` are supported
   without changing the pool to a paid feature plan.
3. The exact AWS resources, IAM actions, environment variables, and repository
   files you propose to create or modify.
4. A cost-impact statement, including whether every proposed component should
   remain within free-tier/near-zero usage at current traffic.
5. A rollback plan and local/AWS verification plan.

Stop and wait for explicit owner approval after Phase A.

### Phase B — only after explicit approval

Implement the approved plan with least privilege and infrastructure-as-code or
repeatable scripts checked into this repository. Preserve concurrent changes.
Do not commit, push, deploy unrelated API code, configure domains, or touch
`itsallreal.org`, `bmerge-*`, or `biblical-news-*` resources.

Required behavior:

- Backend-created Cognito shadow users have the immutable game player UUID as
  Cognito `username`; self-registration remains disabled and clients cannot
  select or change it.
- Implement a server-to-server custom-auth flow for both guest and verified
  Apple account sessions. Challenges must use high-entropy, short-lived,
  single-use proof; never use a fixed answer or expose private challenge values.
- Cognito continues to sign access tokens. Do not add paid custom access-token
  claims. The API verifies standard signature, issuer, `token_use=access`, exact
  `client_id`, UUID `username`, then strongly resolves the active player profile.
- Enable Cognito refresh-token rotation with the shortest practical grace period
  (prefer zero after testing). Use `GetTokensFromRefreshToken`; disable
  `ALLOW_REFRESH_TOKEN_AUTH` as required by Cognito rotation.
- Persist only SHA-256 refresh-token hashes for player ownership, rotation,
  expiration, reuse detection, revocation, and `revokeAll(playerId)`. Never log
  or store raw access/refresh tokens, Apple tokens, nonces, challenge answers, or
  AWS credentials.
- Use conditional DynamoDB writes so registration/rotation is race-safe and a
  rotated credential cannot be reused. Add TTL only for cleanup, never as the
  authorization mechanism.
- Map Cognito/provider rejection to generic public authentication failures.
- Keep domain services independent of AWS SDK types and add offline unit tests
  that inspect generated AWS commands without making network calls.
- Wire concrete adapters into the Lambda only after tests pass. Preserve `/health`.
- Add privacy-aware structured audit events for issuance, rotation/reuse, and
  revocation without identifiers or credentials that should not enter logs.
- Update `docs/IMPLEMENTATION_STATUS.md` with immutable identifiers, exact
  settings, validation evidence, remaining gaps, and rollback instructions.

Before applying changes, show the exact Phase B commands. After approval and
implementation, run OpenAPI lint, strict TypeScript compilation, all local tests,
then narrowly scoped AWS smoke tests. Report results and any cost-relevant
settings. Do not commit or push.
