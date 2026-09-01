# ADR 0001: AWS serverless backend with DynamoDB

- Status: Accepted
- Decision date: 2026-08-31
- Approved by: Product owner

## Context

The product specification recommends an AWS serverless backend, while the API
repository originally defaulted to PostgreSQL unless an equivalent design was
explicitly approved. The application needs guest-first identity, Sign in with
Apple, optimistic save synchronization, an authoritative economy ledger,
entitlements, remote content, and account deletion with minimal operations.

## Decision

Use API Gateway HTTP APIs, TypeScript AWS Lambda handlers, DynamoDB, Cognito for
federated identities, S3/CloudFront for content, and CloudWatch for operational
telemetry. Infrastructure will be defined as code and environments will remain
isolated. Domain services depend on repository and identity-provider ports;
AWS SDK types do not enter product-domain models.

No AWS account, resource, credential, deployment, or environment is created by
this decision. Those actions require separate owner approval.

## Consequences

- DynamoDB conditional writes and transactions enforce revisions,
  idempotency, and ledger invariants.
- Access patterns and keys must be documented before tables are provisioned.
- Cognito and Apple credentials remain environment-managed secrets.
- Local tests use in-memory adapters and never require AWS access.
- A later migration requires implementing the same repository ports rather
  than changing the mobile contract.
