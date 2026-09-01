# Stones Cry Out API

This repository owns the backend implementation and the authoritative OpenAPI 3.1 contract at `openapi/product-api.yaml`.

The contract is expanded incrementally from the reviewed account, sync, economy,
purchase, content, and privacy requirements in `../thestonescryout.docs`. Mobile
clients never receive database or infrastructure credentials.

The owner approved the AWS serverless/DynamoDB architecture on 2026-08-31. See
`docs/adr/0001-aws-serverless-dynamodb.md`. This decision does not authorize
resource provisioning or deployment.

## Local validation

Requires Node.js 22 or newer:

```sh
npm install
npm test
```
