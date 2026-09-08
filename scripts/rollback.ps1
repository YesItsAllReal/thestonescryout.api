#Requires -Version 5.1
# scripts/rollback.ps1
# Executes a selected rollback phase using the manifest written during snapshot capture.
#
# Usage:
#   .\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-20260902120000.json -Phase R1
#   .\scripts\rollback.ps1 -ManifestPath .\rollback\manifest-20260902120000.json -Phase All
#
# Phases:
#   R1  -- Detach Cognito triggers (operator, sco-dev)
#   R2  -- Restore previous API Lambda code (operator, sco-dev) -- BEFORE R3
#   R3  -- Restore original Lambda handler + exact original environment (operator, sco-dev)
#   R4a -- Restore Cognito client, operational rollback (operator, sco-dev)
#   R4b -- Full baseline pool rollback (trusted admin, ItsAllRealAdmin, separate approval)
#   R5  -- Restore IAM policy (trusted admin, ItsAllRealAdmin)
#   All -- Run R1, R2, R3, R4a in order (operator phases only)

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][ValidateSet("R1","R2","R3","R4a","R4b","R5","All")]
    [string]$Phase,
    [string]$OperatorProfile = "sco-dev",
    [string]$AdminProfile    = "ItsAllRealAdmin",
    [string]$Region          = "us-east-1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "aws-helpers.ps1")

# ---------------------------------------------------------------------------
# Validate ManifestPath stays inside the rollback directory.
# ---------------------------------------------------------------------------
$resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
$rollbackDir      = [System.IO.Path]::GetFullPath([System.IO.Path]::GetDirectoryName($resolvedManifest))
$repoRoot         = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$expectedBase     = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "rollback"))

if (-not $resolvedManifest.StartsWith($expectedBase + [System.IO.Path]::DirectorySeparatorChar) -and
    $resolvedManifest -ne $expectedBase) {
    throw "ManifestPath must be inside the repository rollback\ directory."
}
if (-not (Test-Path $resolvedManifest)) {
    throw "Manifest file not found: $resolvedManifest"
}

# ---------------------------------------------------------------------------
# Load and verify manifest.
# ---------------------------------------------------------------------------
$m = Get-Content $resolvedManifest -Raw | ConvertFrom-Json

$requiredFields = @(
    "timestamp", "poolSnapshot", "clientSnapshot", "iamPolicy",
    "apiLambdaZip", "apiLambdaSha256", "originalHandler", "originalEnvSnapshot"
)
foreach ($field in $requiredFields) {
    if ($null -eq $m.$field -or "$($m.$field)".Trim() -eq "") {
        throw "Manifest is missing required field: $field"
    }
}

$artifactPath = Join-Path $rollbackDir $m.apiLambdaZip
if (-not (Test-Path $artifactPath)) {
    throw "Rollback artifact not found: $artifactPath"
}

$actualSha = (Get-FileHash -Path $artifactPath -Algorithm SHA256).Hash
if ($actualSha -ne $m.apiLambdaSha256) {
    # Never print the expected or actual hash values in the error message.
    throw "Rollback artifact SHA256 mismatch. Do not proceed."
}
Write-Host "Manifest loaded and artifact verified: $($m.apiLambdaZip)"

# Load the original environment snapshot (separate file, not in manifest JSON).
$envSnapshotPath = Join-Path $rollbackDir $m.originalEnvSnapshot
if (-not (Test-Path $envSnapshotPath)) {
    throw "Original environment snapshot not found: $envSnapshotPath"
}
$originalEnv = Get-Content $envSnapshotPath -Raw | ConvertFrom-Json

# ---------------------------------------------------------------------------
# Phase functions
# ---------------------------------------------------------------------------

function Invoke-R1 {
    Write-Host "`n[R1] Detach Cognito triggers"
    Invoke-AwsChecked "cognito-idp" "update-user-pool" `
        "--user-pool-id" "us-east-1_SDheytSys" `
        "--policies" '{"PasswordPolicy":{"MinimumLength":20,"RequireUppercase":false,"RequireLowercase":false,"RequireNumbers":false,"RequireSymbols":false,"TemporaryPasswordValidityDays":7},"SignInPolicy":{"AllowedFirstAuthFactors":["PASSWORD"]}}' `
        "--admin-create-user-config" '{"AllowAdminCreateUserOnly":true,"UnusedAccountValidityDays":7}' `
        "--account-recovery-setting" '{"RecoveryMechanisms":[{"Priority":1,"Name":"admin_only"}]}' `
        "--lambda-config" '{}' `
        "--mfa-configuration" "OFF" `
        "--email-configuration" '{"EmailSendingAccount":"COGNITO_DEFAULT"}' `
        "--verification-message-template" '{"DefaultEmailOption":"CONFIRM_WITH_CODE"}' `
        "--user-attribute-update-settings" '{"AttributesRequireVerificationBeforeUpdate":[]}' `
        "--deletion-protection" "ACTIVE" `
        "--region" $Region "--profile" $OperatorProfile | Out-Null
    Write-Host "R1 complete: triggers detached."
}

function Invoke-R2 {
    Write-Host "`n[R2] Restore previous API Lambda code (before handler/env)"
    Invoke-AwsChecked "lambda" "update-function-code" `
        "--function-name" "sco-dev-api" `
        "--zip-file" "fileb://$artifactPath" `
        "--region" $Region "--profile" $OperatorProfile | Out-Null

    Invoke-AwsChecked "lambda" "wait" "function-updated" `
        "--function-name" "sco-dev-api" "--region" $Region "--profile" $OperatorProfile | Out-Null

    $cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
        "--function-name" "sco-dev-api" "--profile" $OperatorProfile
    if ($cfg.LastUpdateStatus -ne "Successful") {
        throw "Lambda code rollback did not succeed: $($cfg.LastUpdateStatusReason)"
    }
    Write-Host "R2 complete: Lambda code restored."
}

function Invoke-R3 {
    Write-Host "`n[R3] Restore original Lambda handler and exact original environment"

    # Build the --environment argument from the captured snapshot.
    # Never prints environment values.
    $envArg = ConvertTo-LambdaEnvArg $originalEnv

    Invoke-AwsChecked "lambda" "update-function-configuration" `
        "--function-name" "sco-dev-api" `
        "--handler" $m.originalHandler `
        "--environment" $envArg `
        "--region" $Region "--profile" $OperatorProfile | Out-Null

    Invoke-AwsChecked "lambda" "wait" "function-updated" `
        "--function-name" "sco-dev-api" "--region" $Region "--profile" $OperatorProfile | Out-Null

    $cfg = Invoke-AwsJson "lambda" "get-function-configuration" `
        "--function-name" "sco-dev-api" "--profile" $OperatorProfile
    if ($cfg.LastUpdateStatus -ne "Successful") {
        throw "Lambda config rollback did not succeed: $($cfg.LastUpdateStatusReason)"
    }
    if ($cfg.Handler -ne $m.originalHandler) {
        throw "Handler was not restored. Expected $($m.originalHandler), got $($cfg.Handler)"
    }

    # Verify restored environment by comparing names and values in memory.
    # Never prints values.
    $restoredProps  = @($cfg.Environment.Variables.PSObject.Properties)
    $expectedProps  = @($originalEnv.PSObject.Properties)
    $restoredNames  = $restoredProps | ForEach-Object { $_.Name }
    $expectedNames  = $expectedProps | ForEach-Object { $_.Name }
    $missingNames   = $expectedNames  | Where-Object { $restoredNames -notcontains $_ }
    $extraNames     = $restoredNames  | Where-Object { $expectedNames -notcontains $_ }
    $mismatchValues = $expectedProps  | Where-Object { $cfg.Environment.Variables.($_.Name) -ne $_.Value }

    if ($missingNames.Count -gt 0 -or $extraNames.Count -gt 0 -or $mismatchValues.Count -gt 0) {
        throw "Restored environment does not match original. Mismatch detected (values not printed)."
    }

    Write-Host "R3 complete: handler=$($cfg.Handler), environment verified."
}

function Invoke-R4a {
    Write-Host "`n[R4a] Restore Cognito client (operational rollback, retains security improvements)"
    Invoke-AwsChecked "cognito-idp" "update-user-pool-client" `
        "--user-pool-id" "us-east-1_SDheytSys" `
        "--client-id" "5vkq6jm3vbulh6v8n4f565benr" `
        "--client-name" "sco-dev-mobile" `
        "--refresh-token-validity" "30" "--access-token-validity" "60" `
        "--token-validity-units" '{"AccessToken":"minutes","RefreshToken":"days"}' `
        "--explicit-auth-flows" "ALLOW_CUSTOM_AUTH" "ALLOW_REFRESH_TOKEN_AUTH" `
        "--no-allowed-o-auth-flows-user-pool-client" `
        "--prevent-user-existence-errors" "ENABLED" `
        "--enable-token-revocation" `
        "--no-enable-propagate-additional-user-context-data" `
        "--auth-session-validity" "3" `
        "--refresh-token-rotation" '{"Feature":"DISABLED"}' `
        "--region" $Region "--profile" $OperatorProfile | Out-Null
    Write-Host "R4a complete: client restored, rotation disabled, ALLOW_REFRESH_TOKEN_AUTH restored."
}

function Invoke-R4b {
    Write-Host "`n[R4b] Full baseline pool rollback (REQUIRES SEPARATE OWNER CONFIRMATION)"
    Write-Host "  This restores AllowAdminCreateUserOnly=false and reopens self-registration."
    $confirm = Read-Host "  Type CONFIRM to proceed, anything else to abort"
    if ($confirm -ne "CONFIRM") {
        Write-Host "  Aborted by operator."
        return
    }
    $poolSnapshot = Get-Content (Join-Path $rollbackDir $m.poolSnapshot) -Raw | ConvertFrom-Json
    $pool = $poolSnapshot.UserPool
    Invoke-AwsChecked "cognito-idp" "update-user-pool" `
        "--user-pool-id" "us-east-1_SDheytSys" `
        "--policies" ($pool.Policies | ConvertTo-Json -Compress) `
        "--admin-create-user-config" ($pool.AdminCreateUserConfig | ConvertTo-Json -Compress) `
        "--account-recovery-setting" ($pool.AccountRecoverySetting | ConvertTo-Json -Compress) `
        "--lambda-config" '{}' `
        "--mfa-configuration" $pool.MfaConfiguration `
        "--email-configuration" ($pool.EmailConfiguration | ConvertTo-Json -Compress) `
        "--verification-message-template" ($pool.VerificationMessageTemplate | ConvertTo-Json -Compress) `
        "--user-attribute-update-settings" ($pool.UserAttributeUpdateSettings | ConvertTo-Json -Compress) `
        "--deletion-protection" $pool.DeletionProtection `
        "--region" $Region "--profile" $AdminProfile | Out-Null
    Write-Host "R4b complete: pool fully restored to baseline."
}

function Invoke-R5 {
    Write-Host "`n[R5] Restore IAM policy (trusted administrator)"
    $policyDoc = (Get-Content (Join-Path $rollbackDir $m.iamPolicy) -Raw | ConvertFrom-Json).PolicyDocument `
        | ConvertTo-Json -Depth 10 -Compress
    Invoke-AwsChecked "iam" "put-role-policy" `
        "--role-name" "sco-dev-lambda-role" `
        "--policy-name" "sco-dev-lambda-policy" `
        "--policy-document" $policyDoc `
        "--profile" $AdminProfile | Out-Null
    Write-Host "R5 complete: IAM policy restored."
}

# ---------------------------------------------------------------------------
# Execute selected phase(s)
# ---------------------------------------------------------------------------
switch ($Phase) {
    "R1"  { Invoke-R1 }
    "R2"  { Invoke-R2 }
    "R3"  { Invoke-R3 }
    "R4a" { Invoke-R4a }
    "R4b" { Invoke-R4b }
    "R5"  { Invoke-R5 }
    "All" {
        Invoke-R1
        Invoke-R2
        Invoke-R3
        Invoke-R4a
        Write-Host "`nAll operator rollback phases complete."
        Write-Host "R4b (full baseline pool) and R5 (IAM) require trusted administrator and separate approval."
    }
}
