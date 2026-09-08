# Checkpoint 6 deployment runbook -- dev environment

Status: PLANNING ONLY. No step has been executed.
Each phase requires separate explicit owner approval before execution.

AWS account: 598628878271  Region: us-east-1
Trusted-administrator profile: ItsAllRealAdmin (non-root IAM user, not root)
Operator profile: sco-dev (Identity Center -- configured in Phase 0)

Approved economy values (trusted server configuration, never from client):
  SCO_GUEST_STARTING_COINS=200  SCO_GUEST_STARTING_GEMS=20  SCO_GUEST_STARTING_ENERGY=200

Future signed remote configuration must use:
  startingCoins=200  startingGems=20  startingEnergy=200  energyCap=200

Apple authentication gate: SCO_APPLE_AUDIENCE is omitted from Phase 3c until
com.itsallrealministries.stonescryout is confirmed as Sign in with Apple-enabled
in the Apple Developer portal. The Lambda starts normally without it; Apple
routes return 503 until the variable is set and confirmed.

---

## Shell requirement

Windows PowerShell 5.1 (default on Windows 10/11) or PowerShell 7+.
All scripts use #Requires -Version 5.1 and are PS 5.1 compatible.

```powershell
$PSVersionTable.PSVersion   # Must show Major >= 5, Minor >= 1
```

All AWS CLI calls use Invoke-AwsChecked (scripts/aws-helpers.ps1) which checks
$LASTEXITCODE after every native aws.exe call and stops on nonzero. $ErrorActionPreference
alone does not convert native exit codes to terminating errors in PS 5.1.

---

## Artifact build (run locally before any AWS step)

```powershell
npm run check   # must pass 225/225
npm run bundle  # builds, packages, and validates both Lambda artifacts
# Expected: "All artifacts validated."
# Artifacts:
#   dist-lambda\api.zip              -- API Lambda (CJS, all deps bundled)
#   dist-lambda\cognito-triggers.zip -- Cognito trigger dispatcher (CJS)
```

Lambda handler configuration after deployment:
  sco-dev-api:              handler = api.handler
  sco-dev-cognito-triggers: handler = cognito-triggers.handler

---

## Preflight checks (read-only, run before any mutation)

```powershell
. .\scripts\aws-helpers.ps1

# Verify ItsAllRealAdmin is NOT root.
$id = Invoke-AwsJson "sts" "get-caller-identity" "--profile" "ItsAllRealAdmin"
if ($id.Arn -match ":root") { Write-Error "Root credentials detected. STOP."; exit 1 }
Write-Host "Caller: $($id.Arn)"

# Verify current Lambda handler (must be src/lambda/index.handler before deployment).
$cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
  "--function-name" "sco-dev-api" "--profile" "ItsAllRealAdmin"
if ($cfg.Handler -ne "src/lambda/index.handler") {
    Write-Error "Unexpected handler: $($cfg.Handler). STOP."
    exit 1
}
Write-Host "Handler: $($cfg.Handler)  Runtime: $($cfg.Runtime)"

# Verify pool state.
Invoke-AwsChecked "cognito-idp" "describe-user-pool" `
  "--user-pool-id" "us-east-1_SDheytSys" "--profile" "ItsAllRealAdmin" `
  "--query" "UserPool.{AdminOnly:AdminCreateUserConfig.AllowAdminCreateUserOnly,Lambda:LambdaConfig}" | Write-Host

# Verify DynamoDB TTL is disabled.
Invoke-AwsChecked "dynamodb" "describe-time-to-live" `
  "--table-name" "sco-dev-players" "--profile" "ItsAllRealAdmin" | Write-Host

# Verify health endpoint.
$h = Invoke-RestMethod -Uri "https://q0zoa13ye9.execute-api.us-east-1.amazonaws.com/health" -UseBasicParsing
if ($h.status -ne "ok") { Write-Error "Health check failed. STOP."; exit 1 }
Write-Host "Health: ok"
```

---

## Rollback snapshot capture (run before any mutation)

All artifacts saved to .\rollback\ (git-ignored). Never commit these files.

```powershell
. .\scripts\aws-helpers.ps1
$ts = Get-Date -Format "yyyyMMddHHmmss"
$rd = [System.IO.Path]::GetFullPath(".\rollback")
if (-not (Test-Path $rd)) { New-Item -ItemType Directory -Path $rd | Out-Null }

# Capture current Lambda configuration for rollback restoration.
$preCfg = Invoke-AwsJson "lambda" "get-function-configuration" `
  "--function-name" "sco-dev-api" "--profile" "ItsAllRealAdmin"
$originalHandler = $preCfg.Handler   # "src/lambda/index.handler"
Write-Host "Original handler: $originalHandler"

# Capture original environment variables.
# Store as a separate file so values are never embedded in the manifest JSON.
# Never print environment values.
$originalEnvVars = $preCfg.Environment.Variables
$envSnapshotFile = "env-$ts.json"
$originalEnvVars | ConvertTo-Json -Depth 3 | Out-File "$rd\$envSnapshotFile" -Encoding utf8
Write-Host "Environment snapshot: $rd\$envSnapshotFile"

# Save pool, client, IAM snapshots.
Invoke-AwsChecked "cognito-idp" "describe-user-pool" `
  "--user-pool-id" "us-east-1_SDheytSys" "--profile" "ItsAllRealAdmin" | `
  Out-File "$rd\pool-$ts.json" -Encoding utf8

Invoke-AwsChecked "cognito-idp" "describe-user-pool-client" `
  "--user-pool-id" "us-east-1_SDheytSys" `
  "--client-id" "5vkq6jm3vbulh6v8n4f565benr" "--profile" "ItsAllRealAdmin" | `
  Out-File "$rd\client-$ts.json" -Encoding utf8

Invoke-AwsChecked "iam" "get-role-policy" `
  "--role-name" "sco-dev-lambda-role" `
  "--policy-name" "sco-dev-lambda-policy" "--profile" "ItsAllRealAdmin" | `
  Out-File "$rd\iam-policy-$ts.json" -Encoding utf8

# Download currently deployed Lambda package.
$funcInfo = Invoke-AwsJson "lambda" "get-function" `
  "--function-name" "sco-dev-api" "--profile" "ItsAllRealAdmin"
$rollbackZip = "$rd\api-lambda-$ts.zip"
Invoke-WebRequest -Uri $funcInfo.Code.Location -OutFile $rollbackZip -UseBasicParsing
$sha256 = (Get-FileHash -Path $rollbackZip -Algorithm SHA256).Hash

# Write manifest -- rollback.ps1 reads this file by path.
# originalEnvSnapshot is a filename reference, not the values themselves.
$manifestPath = "$rd\manifest-$ts.json"
@{
    timestamp           = $ts
    originalHandler     = $originalHandler
    originalEnvSnapshot = $envSnapshotFile
    poolSnapshot        = "pool-$ts.json"
    clientSnapshot      = "client-$ts.json"
    iamPolicy           = "iam-policy-$ts.json"
    apiLambdaZip        = "api-lambda-$ts.zip"
    apiLambdaSha256     = $sha256
} | ConvertTo-Json | Out-File $manifestPath -Encoding utf8

Write-Host "Manifest: $manifestPath"
Write-Host "Snapshot capture complete. Verify all files exist before proceeding."
```

---

## Phase 0 -- Identity Center setup (trusted administrator, one-time)

Requires separate owner approval. Uses ItsAllRealAdmin.
If Identity Center cannot be enabled without broader organization changes, STOP
and report. Do NOT fall back to a long-lived IAM user access key automatically.
Do NOT create both an Identity Center operator and a long-lived sco-dev-operator IAM user.

```powershell
. .\scripts\aws-helpers.ps1
# Verify Identity Center is enabled after console setup:
$sso = Invoke-AwsJson "sso-admin" "list-instances" "--profile" "ItsAllRealAdmin"
if ($sso.Instances.Count -eq 0) { Write-Error "Identity Center not enabled. STOP."; exit 1 }
Write-Host "Identity Center instance: $($sso.Instances[0].InstanceArn)"

# After creating ScoDevOperator permission set and assigning to owner's user:
aws configure sso --profile sco-dev
# Enter: SSO start URL, region us-east-1, account 598628878271, ScoDevOperator

# Before each deployment session:
aws sso login --profile sco-dev
$opId = Invoke-AwsJson "sts" "get-caller-identity" "--profile" "sco-dev"
if ($opId.Account -ne "598628878271") { Write-Error "Wrong account. STOP."; exit 1 }
Write-Host "Operator identity: $($opId.Arn)"
```

---

## Phase 1 -- Trusted-administrator one-time resource creation

Requires separate owner approval. Uses --profile ItsAllRealAdmin.

### ScoDevOperator permission set inline policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CognitoPoolMutations",
      "Effect": "Allow",
      "Action": ["cognito-idp:UpdateUserPool","cognito-idp:UpdateUserPoolClient"],
      "Resource": "arn:aws:cognito-idp:us-east-1:598628878271:userpool/us-east-1_SDheytSys"
    },
    {
      "Sid": "LambdaTriggerUpdate",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode","lambda:UpdateFunctionConfiguration","lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:us-east-1:598628878271:function:sco-dev-cognito-triggers"
    },
    {
      "Sid": "LambdaApiUpdate",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode","lambda:UpdateFunctionConfiguration","lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:us-east-1:598628878271:function:sco-dev-api"
    },
    {
      "Sid": "DynamoTTL",
      "Effect": "Allow",
      "Action": "dynamodb:UpdateTimeToLive",
      "Resource": "arn:aws:dynamodb:us-east-1:598628878271:table/sco-dev-players"
    },
    {
      "Sid": "LogsRead",
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": [
        "arn:aws:logs:us-east-1:598628878271:log-group:/sco/dev/api:*",
        "arn:aws:logs:us-east-1:598628878271:log-group:/sco/dev/cognito-triggers:*"
      ]
    },
    {
      "Sid": "ReadOnly",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:DescribeUserPool","cognito-idp:DescribeUserPoolClient",
        "lambda:GetFunctionConfiguration","iam:GetRolePolicy",
        "dynamodb:DescribeTable","dynamodb:DescribeTimeToLive",
        "logs:DescribeLogGroups","sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

lambda:DeleteFunction is intentionally omitted. Detaching triggers is sufficient
for rollback. Deletion is a separately approved cleanup step.

### 1a-1e. Resource creation

```powershell
. .\scripts\aws-helpers.ps1

# 1a. Trigger execution role.
Invoke-AwsChecked "iam" "create-role" `
  "--role-name" "sco-dev-cognito-triggers-role" `
  "--assume-role-policy-document" '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' `
  "--profile" "ItsAllRealAdmin" | Out-Null

Invoke-AwsChecked "iam" "put-role-policy" `
  "--role-name" "sco-dev-cognito-triggers-role" `
  "--policy-name" "sco-dev-cognito-triggers-policy" `
  "--policy-document" '{"Version":"2012-10-17","Statement":[{"Sid":"Logs","Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:us-east-1:598628878271:log-group:/sco/dev/cognito-triggers:*"}]}' `
  "--profile" "ItsAllRealAdmin" | Out-Null

# 1b. Trigger log group.
Invoke-AwsChecked "logs" "create-log-group" `
  "--log-group-name" "/sco/dev/cognito-triggers" "--region" "us-east-1" "--profile" "ItsAllRealAdmin" | Out-Null
Invoke-AwsChecked "logs" "put-retention-policy" `
  "--log-group-name" "/sco/dev/cognito-triggers" "--retention-in-days" "14" `
  "--region" "us-east-1" "--profile" "ItsAllRealAdmin" | Out-Null

# 1c. Deploy validated trigger artifact.
if (-not (Test-Path "dist-lambda\cognito-triggers.zip")) { Write-Error "Run npm run bundle first."; exit 1 }
Invoke-AwsChecked "lambda" "create-function" `
  "--function-name" "sco-dev-cognito-triggers" `
  "--runtime" "nodejs22.x" "--architectures" "arm64" `
  "--role" "arn:aws:iam::598628878271:role/sco-dev-cognito-triggers-role" `
  "--handler" "cognito-triggers.handler" `
  "--zip-file" "fileb://dist-lambda/cognito-triggers.zip" `
  "--timeout" "5" "--memory-size" "128" `
  "--logging-config" "LogFormat=JSON,LogGroup=/sco/dev/cognito-triggers" `
  "--region" "us-east-1" "--profile" "ItsAllRealAdmin" | Out-Null
Invoke-AwsChecked "lambda" "wait" "function-active" `
  "--function-name" "sco-dev-cognito-triggers" "--region" "us-east-1" "--profile" "ItsAllRealAdmin" | Out-Null
Write-Host "sco-dev-cognito-triggers is active."

# 1d. Grant Cognito permission to invoke the trigger function.
Invoke-AwsChecked "lambda" "add-permission" `
  "--function-name" "sco-dev-cognito-triggers" `
  "--statement-id" "cognito-triggers" "--action" "lambda:InvokeFunction" `
  "--principal" "cognito-idp.amazonaws.com" `
  "--source-arn" "arn:aws:cognito-idp:us-east-1:598628878271:userpool/us-east-1_SDheytSys" `
  "--region" "us-east-1" "--profile" "ItsAllRealAdmin" | Out-Null

# 1e. Add Cognito statement to API Lambda execution role.
# Five required actions: AdminCreateUser, AdminGetUser, AdminSetUserPassword,
# AdminInitiateAuth, AdminRespondToAuthChallenge.
# AdminGetUser is required for every repeat sign-in and must not be omitted.
$cognitoPolicy = '{"Version":"2012-10-17","Statement":[{"Sid":"DynamoDB","Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:TransactWriteItems","dynamodb:Query"],"Resource":["arn:aws:dynamodb:us-east-1:598628878271:table/sco-dev-players","arn:aws:dynamodb:us-east-1:598628878271:table/sco-dev-players/index/*"]},{"Sid":"Logs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:us-east-1:598628878271:log-group:/sco/dev/api:*"},{"Sid":"SSM","Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters"],"Resource":"arn:aws:ssm:us-east-1:598628878271:parameter/sco/dev/*"},{"Sid":"Cognito","Effect":"Allow","Action":["cognito-idp:AdminCreateUser","cognito-idp:AdminGetUser","cognito-idp:AdminSetUserPassword","cognito-idp:AdminInitiateAuth","cognito-idp:AdminRespondToAuthChallenge"],"Resource":"arn:aws:cognito-idp:us-east-1:598628878271:userpool/us-east-1_SDheytSys"}]}'
Invoke-AwsChecked "iam" "put-role-policy" `
  "--role-name" "sco-dev-lambda-role" `
  "--policy-name" "sco-dev-lambda-policy" `
  "--policy-document" $cognitoPolicy `
  "--profile" "ItsAllRealAdmin" | Out-Null
Write-Host "Phase 1 complete."
```


---

## Phase 2 -- Operator: Cognito pool and client configuration

Requires separate owner approval. Uses --profile sco-dev.

```powershell
. .\scripts\aws-helpers.ps1

# 2a. Disable self-registration, set admin_only recovery.
Invoke-AwsChecked "cognito-idp" "update-user-pool" `
  "--user-pool-id" "us-east-1_SDheytSys" `
  "--policies" '{"PasswordPolicy":{"MinimumLength":20,"RequireUppercase":false,"RequireLowercase":false,"RequireNumbers":false,"RequireSymbols":false,"TemporaryPasswordValidityDays":7},"SignInPolicy":{"AllowedFirstAuthFactors":["PASSWORD"]}}' `
  "--admin-create-user-config" '{"AllowAdminCreateUserOnly":true,"UnusedAccountValidityDays":7}' `
  "--account-recovery-setting" '{"RecoveryMechanisms":[{"Priority":1,"Name":"admin_only"}]}' `
  "--mfa-configuration" "OFF" `
  "--email-configuration" '{"EmailSendingAccount":"COGNITO_DEFAULT"}' `
  "--verification-message-template" '{"DefaultEmailOption":"CONFIRM_WITH_CODE"}' `
  "--user-attribute-update-settings" '{"AttributesRequireVerificationBeforeUpdate":[]}' `
  "--deletion-protection" "ACTIVE" `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

$p = Invoke-AwsJson "cognito-idp" "describe-user-pool" `
  "--user-pool-id" "us-east-1_SDheytSys" "--profile" "sco-dev"
if ($p.UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly -ne $true) {
    Write-Error "AllowAdminCreateUserOnly was not set. STOP."; exit 1
}
Write-Host "Phase 2a complete."

# 2b. Enable rotation, remove ALLOW_REFRESH_TOKEN_AUTH.
# SCO_REFRESH_LIFETIME_SECONDS=2592000 matches the 30-day RefreshTokenValidity here.
Invoke-AwsChecked "cognito-idp" "update-user-pool-client" `
  "--user-pool-id" "us-east-1_SDheytSys" `
  "--client-id" "5vkq6jm3vbulh6v8n4f565benr" `
  "--client-name" "sco-dev-mobile" `
  "--refresh-token-validity" "30" "--access-token-validity" "60" `
  "--token-validity-units" '{"AccessToken":"minutes","RefreshToken":"days"}' `
  "--explicit-auth-flows" "ALLOW_CUSTOM_AUTH" `
  "--no-allowed-o-auth-flows-user-pool-client" `
  "--prevent-user-existence-errors" "ENABLED" `
  "--enable-token-revocation" `
  "--no-enable-propagate-additional-user-context-data" `
  "--auth-session-validity" "3" `
  "--refresh-token-rotation" '{"Feature":"ENABLED","RetryGracePeriodSeconds":0}' `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

$c = Invoke-AwsJson "cognito-idp" "describe-user-pool-client" `
  "--user-pool-id" "us-east-1_SDheytSys" `
  "--client-id" "5vkq6jm3vbulh6v8n4f565benr" "--profile" "sco-dev"
if ($c.UserPoolClient.ExplicitAuthFlows -contains "ALLOW_REFRESH_TOKEN_AUTH") {
    Write-Error "ALLOW_REFRESH_TOKEN_AUTH was not removed. STOP."; exit 1
}
Write-Host "Phase 2b complete."
```

---

## Phase 3 -- Operator: DynamoDB TTL, trigger wiring, Lambda handler + env + code

Requires separate owner approval. Uses --profile sco-dev.

```powershell
. .\scripts\aws-helpers.ps1

# 3a. Enable DynamoDB TTL.
Invoke-AwsChecked "dynamodb" "update-time-to-live" `
  "--table-name" "sco-dev-players" `
  "--time-to-live-specification" '{"Enabled":true,"AttributeName":"ttl"}' `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null
Write-Host "Phase 3a complete."

# 3b. Wire triggers to the pool.
$triggerArn = "arn:aws:lambda:us-east-1:598628878271:function:sco-dev-cognito-triggers"
$lambdaConfig = "{`"DefineAuthChallenge`":`"$triggerArn`",`"CreateAuthChallenge`":`"$triggerArn`",`"VerifyAuthChallengeResponse`":`"$triggerArn`"}"
Invoke-AwsChecked "cognito-idp" "update-user-pool" `
  "--user-pool-id" "us-east-1_SDheytSys" `
  "--policies" '{"PasswordPolicy":{"MinimumLength":20,"RequireUppercase":false,"RequireLowercase":false,"RequireNumbers":false,"RequireSymbols":false,"TemporaryPasswordValidityDays":7},"SignInPolicy":{"AllowedFirstAuthFactors":["PASSWORD"]}}' `
  "--admin-create-user-config" '{"AllowAdminCreateUserOnly":true,"UnusedAccountValidityDays":7}' `
  "--account-recovery-setting" '{"RecoveryMechanisms":[{"Priority":1,"Name":"admin_only"}]}' `
  "--lambda-config" $lambdaConfig `
  "--mfa-configuration" "OFF" `
  "--email-configuration" '{"EmailSendingAccount":"COGNITO_DEFAULT"}' `
  "--verification-message-template" '{"DefaultEmailOption":"CONFIRM_WITH_CODE"}' `
  "--user-attribute-update-settings" '{"AttributesRequireVerificationBeforeUpdate":[]}' `
  "--deletion-protection" "ACTIVE" `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null
Write-Host "Phase 3b complete."

# 3c. Update Lambda handler and set environment variables atomically.
# Handler must change from src/lambda/index.handler to api.handler.
# SCO_APPLE_AUDIENCE is intentionally omitted until Apple Developer portal confirmation.
$envVars = "Variables={SCO_ENVIRONMENT=development," +
  "SCO_PLAYER_TABLE_NAME=sco-dev-players," +
  "SCO_TOKEN_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SDheytSys," +
  "SCO_TOKEN_AUDIENCE=5vkq6jm3vbulh6v8n4f565benr," +
  "SCO_COGNITO_USER_POOL_ID=us-east-1_SDheytSys," +
  "SCO_COGNITO_CLIENT_ID=5vkq6jm3vbulh6v8n4f565benr," +
  "SCO_REFRESH_LIFETIME_SECONDS=2592000," +
  "SCO_GUEST_STARTING_COINS=200," +
  "SCO_GUEST_STARTING_GEMS=20," +
  "SCO_GUEST_STARTING_ENERGY=200}"

Invoke-AwsChecked "lambda" "update-function-configuration" `
  "--function-name" "sco-dev-api" `
  "--handler" "api.handler" `
  "--environment" $envVars `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

Invoke-AwsChecked "lambda" "wait" "function-updated" `
  "--function-name" "sco-dev-api" "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

$cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
  "--function-name" "sco-dev-api" "--profile" "sco-dev"
if ($cfg.LastUpdateStatus -ne "Successful") {
    Write-Error "Lambda config update failed: $($cfg.LastUpdateStatusReason). STOP."; exit 1
}
if ($cfg.Handler -ne "api.handler") {
    Write-Error "Handler not updated. Got $($cfg.Handler). STOP."; exit 1
}
Write-Host "Phase 3c complete. Handler=$($cfg.Handler)"

# 3d. Deploy API Lambda code.
if (-not (Test-Path "dist-lambda\api.zip")) { Write-Error "Run npm run bundle first."; exit 1 }

Invoke-AwsChecked "lambda" "update-function-code" `
  "--function-name" "sco-dev-api" `
  "--zip-file" "fileb://dist-lambda/api.zip" `
  "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

Invoke-AwsChecked "lambda" "wait" "function-updated" `
  "--function-name" "sco-dev-api" "--region" "us-east-1" "--profile" "sco-dev" | Out-Null

# Verify all deployment assertions.
$cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
  "--function-name" "sco-dev-api" "--profile" "sco-dev"

if ($cfg.LastUpdateStatus -ne "Successful") {
    Write-Error "Lambda code update failed: $($cfg.LastUpdateStatusReason). STOP."; exit 1
}
if ($cfg.Handler -ne "api.handler") {
    Write-Error "Handler mismatch: $($cfg.Handler). STOP."; exit 1
}
if ($cfg.Runtime -ne "nodejs22.x") {
    Write-Error "Runtime mismatch: $($cfg.Runtime). STOP."; exit 1
}
if ($cfg.Architectures -notcontains "arm64") {
    Write-Error "Architecture mismatch. STOP."; exit 1
}
$env = $cfg.Environment.Variables
$requiredVars = @("SCO_ENVIRONMENT","SCO_PLAYER_TABLE_NAME","SCO_TOKEN_ISSUER",
  "SCO_TOKEN_AUDIENCE","SCO_COGNITO_USER_POOL_ID","SCO_COGNITO_CLIENT_ID",
  "SCO_REFRESH_LIFETIME_SECONDS","SCO_GUEST_STARTING_COINS",
  "SCO_GUEST_STARTING_GEMS","SCO_GUEST_STARTING_ENERGY")
foreach ($v in $requiredVars) {
    if (-not $env.PSObject.Properties[$v]) {
        Write-Error "Missing required env var: $v. STOP."; exit 1
    }
}
if ($env.PSObject.Properties["SCO_APPLE_AUDIENCE"]) {
    Write-Error "SCO_APPLE_AUDIENCE must not be set until Apple Developer portal is confirmed. STOP."
    exit 1
}
Write-Host "Phase 3d complete. All deployment assertions passed."
Write-Host "  Handler=$($cfg.Handler)  Runtime=$($cfg.Runtime)  Arch=$($cfg.Architectures -join ',')"
```

---

## Smoke tests (run after Phase 3 completes)

```powershell
.\scripts\smoke-test.ps1 `
  -Profile sco-dev `
  -ApiEndpoint https://q0zoa13ye9.execute-api.us-east-1.amazonaws.com `
  -RollbackDir .\rollback
# Expected: "Smoke tests PASSED."
```

The smoke test script (scripts/smoke-test.ps1):
- Requires PS 5.1+. Uses Invoke-AwsChecked for all AWS calls.
- Checks $LASTEXITCODE explicitly after every aws logs filter-log-events call.
  A failed or unauthorized log query fails the test -- never silently skipped.
- Captures tokens in memory only. Checks exact token values against both log
  groups while tokens are still in scope, before clearing them.
- Clears all secret-bearing variables in a finally block.
- Revokes the replacement session; confirms it is rejected afterward.
- Saves a fixture manifest to .\rollback\ with exact DynamoDB keys computed
  from non-secret hashes (installationId, idempotencyKey, refreshToken hashes).
  The manifest path uses a single timestamp -- no double Get-Date call.
- Does not claim current-user-only ACLs; the rollback/ directory is git-ignored.

Smoke test fixtures created:
  DynamoDB: PLAYER#<playerId> PROFILE, BALANCE
  DynamoDB: INSTALLATION#<sha256(installationId)> PLAYER
  DynamoDB: IDEMPOTENCY#GUEST#<sha256(idempotencyKey)> RESULT
  DynamoDB: REFRESH#<sha256(refreshToken1)> CREDENTIAL (revoked)
  DynamoDB: REFRESH#<sha256(refreshToken2)> CREDENTIAL (revoked)
  Cognito:  shadow user username=<playerId>
Cleanup requires a separately approved operation targeting exact keys only.

---

## Rollback (use scripts/rollback.ps1)

The rollback script accepts a mandatory -ManifestPath argument, validates the
path stays inside the rollback\ directory, verifies the artifact SHA256, and
executes the selected phase. No manual placeholder substitution.

```powershell
# Load and verify manifest, then run all operator phases:
.\scripts\rollback.ps1 `
  -ManifestPath .\rollback\manifest-<timestamp>.json `
  -Phase All

# Or run individual phases:
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R1
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R2
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R3
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R4a
# R4b and R5 require ItsAllRealAdmin and separate owner confirmation:
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R4b
.\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-<timestamp>.json -Phase R5
```

Rollback phase summary:
  R1  -- Detach Cognito triggers (operator). Retains AllowAdminCreateUserOnly=true.
  R2  -- Restore previous Lambda code (operator). Must run BEFORE R3.
  R3  -- Restore original handler (src/lambda/index.handler) + env vars (operator).
  R4a -- Restore Cognito client: ALLOW_REFRESH_TOKEN_AUTH, rotation=DISABLED (operator).
         Retains AllowAdminCreateUserOnly=true and admin_only recovery as security improvements.
  R4b -- Full baseline pool rollback: restores AllowAdminCreateUserOnly=false and
         verified_email/phone recovery. Requires owner confirmation prompt. (trusted admin)
  R5  -- Restore IAM policy to pre-deployment state. (trusted admin)
  R6  -- TTL disable (optional, trusted admin). TTL is safe to leave enabled.
  R7  -- Trigger function deletion (optional, trusted admin, separate approval).

After rollback, verify:
```powershell
. .\scripts\aws-helpers.ps1
$cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
  "--function-name" "sco-dev-api" "--profile" "sco-dev"
if ($cfg.Handler -ne "src/lambda/index.handler") {
    Write-Error "Handler not restored. Got $($cfg.Handler)."
}
$env = $cfg.Environment.Variables
if ($env.PSObject.Properties.Count -ne 1 -or -not $env.PSObject.Properties["NODE_ENV"]) {
    Write-Error "Environment not restored to NODE_ENV=development only."
}
Write-Host "Rollback verified: Handler=$($cfg.Handler)"
```

---

## Runbook accuracy notes

- Apple routes are ACTIVE when SCO_APPLE_AUDIENCE is set; 503 when absent.
  Phase 3c omits it until Apple Developer portal confirmation is recorded.
- Lambda artifacts are CJS bundles with all runtime dependencies included.
  Handler paths: api.handler (api.zip) and cognito-triggers.handler (cognito-triggers.zip).
- All AWS CLI calls use Invoke-AwsChecked which stops on nonzero $LASTEXITCODE.
- Rollback ordering: R2 (code) before R3 (handler+env) prevents cold-start failure.
- R3 restores the original handler (src/lambda/index.handler) and exact original
  environment captured in the env-<timestamp>.json snapshot file. Values are
  never printed; the restored environment is verified in memory.
- Rollback R1-R4a is fully executable via rollback.ps1 with no placeholders.
  R4b and R5 require the trusted administrator. R6-R7 are optional cleanup.
- Smoke test log checks are hard failures -- not silently skipped.

---

## Estimated cost (dev, near-zero traffic)

  Cognito, Lambda, DynamoDB, CloudWatch, Identity Center, esbuild: $0.00
  Total additional monthly cost: $0.00
  Cost becomes non-zero above 10,000 Cognito MAU/month at $0.0055/MAU.
