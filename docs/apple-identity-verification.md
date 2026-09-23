# Sign in with Apple verification

Status: identity-token verifier implemented and validated locally. On
2026-09-22 the owner confirmed that the explicit App ID
`com.itsallrealministries.stonescryout` has Sign in with Apple enabled and is
configured as the primary App ID. A configuration-only update activated that
audience in the development Lambda on the same date without changing code or
other settings. Unsigned iOS CI passed, the protected TestFlight workflow and
provisioning entitlement checks passed, and the owner completed a successful
real-device Apple sign-in on 2026-09-23. Conflict reconciliation remains a
separate undeployed path.

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

## Confirmed deployment input

- Native iOS App ID and exact development audience:
  `com.itsallrealministries.stonescryout`.

## Inputs still required only for later capabilities

- Apple developer team/key identifiers and private-key storage approach if an
  authorization-code or revocation integration is enabled.
- Confirmation that the iOS nonce implementation follows the raw/digest
  convention above.

No Apple private key is required for JWKS identity-token verification.
