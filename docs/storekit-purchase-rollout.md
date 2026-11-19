# StoreKit Energy Refill rollout

The API accepts one StoreKit 2 signed transaction per request at
`POST /v1/purchases/verify`. The iOS client supplies its authenticated
player UUID as `appAccountToken` when starting the purchase and finishes the
StoreKit transaction after the API confirms durable processing.

| App Store Connect field | Value |
| --- | --- |
| Display name | Energy Refill |
| Product ID | `EnergyRefill100` |
| Product type | Consumable |
| US price | $0.99, managed in App Store Connect |
| Bundle ID | `com.itsallrealministries.stonescryout` |

A verified single-unit purchase grants 100 energy and writes one ledger entry.
The purchase creates no entitlement. The same idempotency key replays its
stored result. A new key for the same transaction returns the existing ledger
grant with the current balance and records a duplicate receipt.

## Configuration

| Setting | TestFlight | Production |
| --- | --- | --- |
| `SCO_ENVIRONMENT` | `development` or `staging` | `production` |
| `SCO_APP_STORE_ENVIRONMENT` | `sandbox` | `production` |
| `SCO_APP_STORE_APPLE_ID` | Omit | The app's numeric Apple ID from App Store Connect → App Information |

Keep each API's existing Cognito configuration and set `SCO_PLAYER_TABLE_NAME`
to the corresponding environment's existing table. TestFlight must target an
isolated test backend, with its own player table and authentication boundary.
The runtime rejects a Sandbox/Production configuration mismatch. Omitting
`SCO_APP_STORE_ENVIRONMENT` or setting it to `disabled` keeps this authenticated
route at 503. The production numeric Apple ID has not been confirmed and is a
production activation blocker. Apple's transaction verification checks the
signed bundle and environment. The transaction JWS does not carry the numeric
Apple ID, which the library requires when constructing the Production verifier.

The Lambda bundle includes [Apple Root CA - G3](https://www.apple.com/certificateauthority/AppleRootCA-G3.cer)
from [Apple PKI](https://www.apple.com/certificateauthority/), SHA-256
`63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179`.
The Apple App Store Server Library verifies the certificate path to that trust
anchor and checks certificate revocation online. Allow outbound access from
Lambda to the Apple OCSP endpoints in the signed certificate chain
(typically HTTP port 80) and verify that the Lambda and API timeouts accommodate
cold-cache checks. No operator certificate upload or App Store Server API key
is required. Retryable Apple verification failures return 503. Transaction
verification and granted balance changes do not depend on a notification
endpoint. Server Notifications V2 remain disabled and refund handling is
outside this rollout.

## Deploy after explicit approval

1. Confirm the product in App Store Connect and the existing TestFlight build's
   target API and player UUID binding. Apple processes TestFlight purchases in
   [Sandbox without charges](https://developer.apple.com/documentation/storekit/testing-at-all-stages-of-development-with-xcode-and-the-sandbox).
2. Confirm the test Lambda's API Gateway route, Apple OCSP access, and existing
   DynamoDB permissions for strongly consistent reads, conditional writes, and
   transaction writes on the test player table. Use the existing table schema.
3. Capture the current API version or verified ZIP and environment securely,
   following the [deployment runbook](deployment-runbook-checkpoint-6.md).
   Deploy the locally validated `dist-lambda/api.zip` to the test API with
   `SCO_APP_STORE_ENVIRONMENT=sandbox`. Preserve the rest of its environment.
4. Check health and authentication. On TestFlight, buy Energy Refill with a
   test player, verify a +100 energy change and one IAP ledger entry, then retry
   the transaction with the original and a fresh idempotency key. Verify both
   return the prior grant with no new ledger entry. Inspect sanitized status
   and correlation logs. Keep the transaction JWS and tokens out of logs.
5. Keep Production disabled for this rollout. Any later Production activation
   requires the confirmed numeric Apple ID and separate deployment approval.

## Roll back after explicit approval

Disable new verifications with `SCO_APP_STORE_ENVIRONMENT=disabled` or point the
API alias back to the previous Lambda version. For a direct Lambda update,
restore the previous API ZIP and environment from the verified snapshot using
the API code and configuration phases (R2 and R3) in the deployment runbook.
Confirm health, authenticated purchase 503, and existing balances. Preserve
transaction claims, ledger entries and idempotency results so reactivation
cannot duplicate a prior grant. Unfinished StoreKit transactions can retry
after service resumes.
