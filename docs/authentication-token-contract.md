# Authentication token contract

Status: application boundary implemented and validated locally; Cognito custom
authentication, refresh rotation, and guest issuance are not yet configured or
deployed.

## Accepted access token

Authenticated API routes accept only a signed JWT satisfying all of these rules:

- Signature algorithm is RS256 and the signing key resolves from the configured
  issuer's `/.well-known/jwks.json` document.
- `iss` exactly matches the environment-supplied Cognito issuer.
- `exp` and other JWT time constraints pass against the server clock with five
  seconds of clock tolerance.
- `token_use` is exactly `access`.
- `client_id` exactly matches the environment-supplied mobile app client ID.
- In the free-tier path, standard Cognito `username` must be the immutable game
  player UUID assigned when the backend creates the shadow user. The verified
  username is only a lookup key: the API performs a strongly consistent profile
  lookup and derives `playerId` and `sessionKind` from active DynamoDB state.
- A missing, malformed, unknown, or deletion-pending profile is rejected.

The verifier does not use Cognito `sub`, Apple `sub`, an email address, or any
caller-selected identifier as the game player ID. It returns only the minimal
verified principal required for authorization. Tokens, Cognito subjects, and
rejected claim values are not included in public errors or structured logs.

## Cognito integration requirement

The selected Option 1 Lite design avoids V2 pre-token access-token customization,
which can add Cognito feature-plan cost. The backend creates one Cognito shadow
user per game player with the immutable player UUID as `username`; clients can
neither create users nor choose usernames. Every authenticated request maps that
signed standard claim back through the authoritative player profile.

Guest session token issuance remains a separate boundary. The current Cognito
app client's custom-auth settings alone are insufficient: the challenge/triggers,
server-side player binding, refresh lifecycle, revocation behavior, and abuse
controls must be designed and tested before `/v1/guest/session` is deployed as a
functional authentication endpoint.

## Refresh and revocation lifecycle

- `POST /v1/session/refresh` accepts an opaque refresh credential in its JSON
  body and requires the provider to validate and rotate it before returning a
  replacement access/refresh pair.
- A rotated credential cannot be accepted again. Detected reuse may revoke its
  entire token family according to the provider adapter's security policy.
- `POST /v1/session/revoke` requires both a valid access token and the refresh
  credential. The provider must prove the refresh credential belongs to the
  access token's authoritative `player_id` before revocation.
- Revocation is safe to repeat. Account deletion continues to use the stronger
  `revokeAll(playerId)` boundary after its deletion request is durably recorded.
- Refresh credentials never appear in query strings, path components, logs,
  public errors, player records, or idempotency fingerprints.
- Cognito refresh-token rotation must be active and refresh must use
  `GetTokensFromRefreshToken`; `ALLOW_REFRESH_TOKEN_AUTH` must be disabled when
  rotation is enabled. Missing replacement refresh tokens fail closed.
- Only SHA-256 hashes of refresh credentials are stored in the ownership registry.

## Environment configuration

- `SCO_ENVIRONMENT`: `development`, `staging`, or `production`.
- `SCO_PLAYER_TABLE_NAME`: physical DynamoDB player table.
- `SCO_TOKEN_ISSUER`: absolute HTTPS Cognito issuer URL.
- `SCO_TOKEN_AUDIENCE`: expected Cognito app client ID; the access-token claim
  checked for this value is `client_id`.
- `SCO_APPLE_AUDIENCE`: exact Apple bundle ID or Services ID accepted in Apple
  identity-token `aud` claims.

No account, Region, pool ID, client ID, URL, key, or credential is hardcoded in
the verifier.
