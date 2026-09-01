# Stones Cry Out API Repository Instructions

Own `openapi/product-api.yaml` as the authoritative OpenAPI 3.1 contract shared by iOS and future Android clients. Read the product rules in `../thestonescryout.docs`, especially the content, account/sync, economy, purchase, and test specifications, before changing behavior.

Keep contract changes compatible and reviewed. Use PostgreSQL and optional Redis only behind the service boundary unless an approved architecture decision selects an equivalent implementation. Require environment-managed secrets, migrations, automated tests, health endpoints, authentication, resource-level authorization, auditing, privacy-aware structured logging, idempotency, and rate limiting. Never expose database credentials to mobile clients or provision infrastructure without explicit user direction.
