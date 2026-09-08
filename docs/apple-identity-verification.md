# Sign in with Apple verification

Status: identity-token verifier implemented and validated locally; Apple
platform registration, identifiers, and deployment configuration remain pending.

## Verification boundary

`AppleJwksVerifier` accepts an Apple credential envelope only after all of the
following checks pass:

- RS256 signature against Apple's `https://appleid.apple.com/auth/keys` JWKS.
- Exact issuer `https://appleid.apple.com`.
- Exact environment-supplied audience from `SCO_APPLE_AUDIENCE`.
- JWT expiry and time validation against the server clock with five seconds of
  tolerance.
- Nonempty bounded Apple subject identifier.
- Constant-time match between the token's `nonce` claim and the lowercase
  SHA-256 digest of the raw nonce supplied to the API.

The mobile client generates a high-entropy raw nonce, places its SHA-256 digest
in the Apple authorization request, and sends the raw nonce in the API credential
envelope. The raw nonce, token, and authorization code are never persisted in a
player profile, logged, or returned.

The optional authorization code is not identity proof and does not bypass JWT
verification. It is reserved for an approved Apple server exchange or credential
revocation adapter. Apple private keys must be stored in an approved secret/key
service and never in source or plaintext Lambda environment variables.

## Deployment inputs still required

- Apple bundle ID or Services ID for each backend environment.
- Exact audience value for each environment.
- Apple developer team/key identifiers and private-key storage approach if an
  authorization-code or revocation integration is enabled.
- Confirmation that the iOS nonce implementation follows the raw/digest
  convention above.

No Apple private key is required for JWKS identity-token verification.
