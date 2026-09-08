#Requires -Version 5.1
# scripts/smoke-test.ps1
# Smoke tests for the sco-dev-api Lambda after deployment.
#
# SHELL REQUIREMENT: Windows PowerShell 5.1 or PowerShell 7+.
# This script does NOT use -SkipHttpErrorCheck (PS 7+ only).
#
# Usage:
#   .\scripts\smoke-test.ps1 -Profile sco-dev -ApiEndpoint https://q0zoa13ye9.execute-api.us-east-1.amazonaws.com
#
# Tokens are captured in memory only. They are NEVER printed, logged, or
# written to disk in plaintext. Shell tracing must not be enabled.
# Do not run with -Verbose or -Debug.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Profile,
    [Parameter(Mandatory)][string]$ApiEndpoint,
    [string]$Region      = "us-east-1",
    [string]$RollbackDir = ".\rollback"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSCmdlet.MyInvocation.BoundParameters.ContainsKey("Verbose") -or
    $PSCmdlet.MyInvocation.BoundParameters.ContainsKey("Debug")) {
    Write-Error "Do not run smoke tests with -Verbose or -Debug: token values could be exposed."
    exit 1
}

. (Join-Path $PSScriptRoot "aws-helpers.ps1")

$pass = 0
$fail = 0

# All secret-bearing variables declared here so the finally block clears them
# even if an early exit occurs.
$accessToken1    = $null
$refreshToken1   = $null
$accessToken2    = $null
$refreshToken2   = $null
$sessionResponse = $null
$refreshResponse = $null
$sessionBody     = $null
$refreshBody1    = $null
$revokeBody      = $null
$claims          = $null
$payload         = $null
$exactSecrets    = $null

try {

# ---------------------------------------------------------------------------
# 1. Health check
# ---------------------------------------------------------------------------
Write-Host "`n[1] Health check"
$health = Invoke-RestMethod -Uri "$ApiEndpoint/health" -Method GET -UseBasicParsing
Assert-Equal "status=ok" $health.status "ok"

# ---------------------------------------------------------------------------
# 2. Unfinished authenticated route returns 401 without bearer
# ---------------------------------------------------------------------------
Write-Host "`n[2] Unfinished authenticated route boundary"
$r2 = Invoke-HttpRequest -Uri "$ApiEndpoint/v1/economy" -Method GET
Assert-Equal "economy returns 401 without bearer" $r2.StatusCode 401

# ---------------------------------------------------------------------------
# 3. Guest session creation -- tokens captured in memory, never printed
# ---------------------------------------------------------------------------
Write-Host "`n[3] Guest session creation"
$idempotencyKey = "smoke-$(Get-Date -Format 'yyyyMMddHHmmss')-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
$installationId = [System.Guid]::NewGuid().ToString()
$sessionBody = (@{
    installationId = $installationId
    locale         = "en-US"
    appBuild       = 1
    platform       = "ios"
} | ConvertTo-Json -Compress)

try {
    $sessionResponse = Invoke-RestMethod `
        -Uri "$ApiEndpoint/v1/guest/session" `
        -Method POST -ContentType "application/json" `
        -Headers @{ "Idempotency-Key" = $idempotencyKey } `
        -Body $sessionBody -UseBasicParsing
} catch {
    Write-Host "  FAIL guest session request failed"
    $script:fail++
}

if ($null -eq $sessionResponse) {
    Write-Host "`n--- Smoke test summary ---"
    Write-Host "PASS: $pass   FAIL: $fail"
    Write-Host "Smoke tests FAILED (no session). Do not proceed."
    exit 1
}

$playerId = $sessionResponse.player.playerId
Assert-Match "playerId is a UUID" $playerId "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
Assert-Equal "accountKind=guest" $sessionResponse.player.accountKind "guest"
Assert-NotEmpty "accessToken present"  $sessionResponse.tokens.accessToken
Assert-NotEmpty "refreshToken present" $sessionResponse.tokens.refreshToken

$accessToken1  = $sessionResponse.tokens.accessToken
$refreshToken1 = $sessionResponse.tokens.refreshToken

# ---------------------------------------------------------------------------
# 4. Access token claims (decoded without printing the token)
# ---------------------------------------------------------------------------
Write-Host "`n[4] Access token claims"
try {
    $parts   = $accessToken1.Split(".")
    $payload = $parts[1].Replace("-", "+").Replace("_", "/")
    switch ($payload.Length % 4) { 2 { $payload += "==" } 3 { $payload += "=" } }
    $claims = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($payload)) | ConvertFrom-Json
    Assert-Equal "token_use=access"   $claims.token_use "access"
    Assert-Equal "client_id matches"  $claims.client_id "5vkq6jm3vbulh6v8n4f565benr"
    Assert-Match "iss is Cognito URL" $claims.iss "cognito-idp\.us-east-1\.amazonaws\.com"
    Assert-Match "username is UUID"   $claims.username `
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
} catch {
    Write-Host "  FAIL token claim decode failed"
    $script:fail++
}
$payload = $null
$claims  = $null

# ---------------------------------------------------------------------------
# 5. Session refresh -- new token pair, tokens never printed
# ---------------------------------------------------------------------------
Write-Host "`n[5] Session refresh"
$refreshBody1 = (@{ refreshToken = $refreshToken1 } | ConvertTo-Json -Compress)
try {
    $refreshResponse = Invoke-RestMethod `
        -Uri "$ApiEndpoint/v1/session/refresh" `
        -Method POST -ContentType "application/json" `
        -Body $refreshBody1 -UseBasicParsing
} catch {
    Write-Host "  FAIL refresh request failed"
    $script:fail++
}

if ($null -eq $refreshResponse) {
    Write-Host "  FAIL refresh returned no response"
    $script:fail++
} else {
    Assert-NotEmpty "new accessToken present"  $refreshResponse.accessToken
    Assert-NotEmpty "new refreshToken present" $refreshResponse.refreshToken
    $accessToken2  = $refreshResponse.accessToken
    $refreshToken2 = $refreshResponse.refreshToken

    # -------------------------------------------------------------------------
    # 6. Original refresh token rejected after rotation
    # -------------------------------------------------------------------------
    Write-Host "`n[6] Original refresh token rejected after rotation"
    $r6 = Invoke-HttpRequest -Uri "$ApiEndpoint/v1/session/refresh" `
        -Method POST -ContentType "application/json" -Body $refreshBody1
    Assert-Equal "original token rejected with 401" $r6.StatusCode 401

    # -------------------------------------------------------------------------
    # 7. Revoke the replacement session
    # -------------------------------------------------------------------------
    Write-Host "`n[7] Revoke replacement session"
    $revokeBody = (@{ refreshToken = $refreshToken2 } | ConvertTo-Json -Compress)
    try {
        $r7 = Invoke-HttpRequest -Uri "$ApiEndpoint/v1/session/revoke" `
            -Method POST -ContentType "application/json" `
            -Headers @{ Authorization = "Bearer $accessToken2" } `
            -Body $revokeBody
        Assert-Equal "revoke returns 204" $r7.StatusCode 204
    } catch {
        Write-Host "  FAIL revoke request failed"
        $script:fail++
    }

    # -------------------------------------------------------------------------
    # 8. Replacement refresh token rejected after revocation
    # -------------------------------------------------------------------------
    Write-Host "`n[8] Replacement refresh token rejected after revocation"
    $r8 = Invoke-HttpRequest -Uri "$ApiEndpoint/v1/session/refresh" `
        -Method POST -ContentType "application/json" `
        -Body (@{ refreshToken = $refreshToken2 } | ConvertTo-Json -Compress)
    Assert-Equal "replacement token rejected with 401" $r8.StatusCode 401
}

# ---------------------------------------------------------------------------
# 9. Log credential leakage check -- both log groups, bounded polling,
#    exact token values checked while still in memory.
# ---------------------------------------------------------------------------
Write-Host "`n[9] Log credential leakage check"

# Collect all exact secret values that must never appear in logs.
# Checked while variables are still in scope, before the finally block.
$exactSecrets = @()
if ($null -ne $accessToken1)  { $exactSecrets += $accessToken1 }
if ($null -ne $refreshToken1) { $exactSecrets += $refreshToken1 }
if ($null -ne $accessToken2)  { $exactSecrets += $accessToken2 }
if ($null -ne $refreshToken2) { $exactSecrets += $refreshToken2 }

$startTimeMs  = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds().ToString()
$logGroups    = @("/sco/dev/api", "/sco/dev/cognito-triggers")
$fieldPatterns = @(
    '"identityToken"', '"refreshToken"', '"accessToken"',
    '"nonce"', '"challengeAnswer"', '"proof"', '"ANSWER"',
    '"Token"', '"AuthenticationResult"'
)

foreach ($logGroup in $logGroups) {
    # Use Invoke-AwsRetryable: bounded polling, $LASTEXITCODE checked inside helper,
    # never prints arguments or response content.
    $result = Invoke-AwsRetryable `
        "logs" "filter-log-events" `
        "--log-group-name" $logGroup `
        "--start-time" $startTimeMs `
        "--profile" $Profile `
        "--region" $Region `
        "--output" "json" `
        -MaxAttempts 6 -DelaySeconds 5

    if (-not $result.Success) {
        # Hard failure -- not a skip.
        Write-Host "  FAIL could not read log group ${logGroup} after retries"
        $script:fail++
        continue
    }

    $logOutput = $result.Output
    $leakFound = $false

    # Check exact token values (while still in memory).
    foreach ($secret in $exactSecrets) {
        if ($logOutput -match [regex]::Escape($secret)) {
            Write-Host "  FAIL ${logGroup} contains an exact token value"
            $script:fail++
            $leakFound = $true
        }
    }

    # Check sensitive field-name patterns.
    foreach ($pattern in $fieldPatterns) {
        if ($logOutput -match [regex]::Escape($pattern)) {
            Write-Host "  FAIL ${logGroup} contains sensitive field pattern: $pattern"
            $script:fail++
            $leakFound = $true
        }
    }

    if (-not $leakFound) {
        Write-Host "  PASS ${logGroup}: no credential leakage detected"
        $script:pass++
    }
}

# ---------------------------------------------------------------------------
# 10. Save fixture manifest (single timestamp, single path)
# ---------------------------------------------------------------------------
if (-not (Test-Path $RollbackDir)) {
    New-Item -ItemType Directory -Path $RollbackDir | Out-Null
}

# Compute exact DynamoDB keys from non-secret hashes before clearing values.
$installationHash = Get-Sha256String $installationId
$idempotencyHash  = Get-Sha256String $idempotencyKey
$refreshHash1 = if ($null -ne $refreshToken1) { Get-Sha256String $refreshToken1 } else { $null }
$refreshHash2 = if ($null -ne $refreshToken2) { Get-Sha256String $refreshToken2 } else { $null }

# Single timestamp and single absolute path -- no double Get-Date call.
$fixtureTs   = Get-Date -Format "yyyyMMddHHmmss"
$manifestAbs = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine((Resolve-Path $RollbackDir).Path, "smoke-fixture-$fixtureTs.json"))

$dynamoKeys = @(
    @{ pk = "PLAYER#$playerId";                   sk = "PROFILE" }
    @{ pk = "PLAYER#$playerId";                   sk = "BALANCE" }
    @{ pk = "INSTALLATION#$installationHash";     sk = "PLAYER" }
    @{ pk = "IDEMPOTENCY#GUEST#$idempotencyHash"; sk = "RESULT" }
)
if ($null -ne $refreshHash1) {
    $dynamoKeys += @{ pk = "REFRESH#$refreshHash1"; sk = "CREDENTIAL" }
}
if ($null -ne $refreshHash2) {
    $dynamoKeys += @{ pk = "REFRESH#$refreshHash2"; sk = "CREDENTIAL" }
}

$manifest = @{
    createdAt   = (Get-Date -Format "o")
    apiEndpoint = $ApiEndpoint
    playerId    = $playerId
    cognitoUser = $playerId
    dynamoKeys  = $dynamoKeys
    note        = "Cleanup requires separate owner approval. Target these exact keys only. No broad scans or deletes."
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText($manifestAbs, $manifest, [System.Text.Encoding]::UTF8)
Write-Host "`nFixture manifest saved: $manifestAbs"
Write-Host "  playerId: $playerId"
Write-Host "  DynamoDB keys recorded for targeted cleanup."
Write-Host "  Note: rollback/ directory is git-ignored. Protect this file manually."

} finally {
    # Clear all secret-bearing variables regardless of how the script exits.
    $accessToken1    = $null
    $refreshToken1   = $null
    $accessToken2    = $null
    $refreshToken2   = $null
    $sessionResponse = $null
    $refreshResponse = $null
    $sessionBody     = $null
    $refreshBody1    = $null
    $revokeBody      = $null
    $claims          = $null
    $payload         = $null
    $exactSecrets    = $null
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`n--- Smoke test summary ---"
Write-Host "PASS: $pass   FAIL: $fail"

if ($fail -gt 0) {
    Write-Host "Smoke tests FAILED. Do not proceed with further deployment."
    exit 1
}

Write-Host "Smoke tests PASSED."
