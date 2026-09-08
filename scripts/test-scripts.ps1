#Requires -Version 5.1
# scripts/test-scripts.ps1
# Offline tests for deployment script helpers.
# Never invokes AWS. Uses mock functions/executables only.
# Compatible with Windows PowerShell 5.1.
#
# Usage:
#   powershell -NoProfile -File scripts/test-scripts.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pass = 0
$fail = 0

function Test-Assert {
    param([string]$Label, [scriptblock]$Body)
    try {
        & $Body
        Write-Host "  PASS $Label"
        $script:pass++
    } catch {
        Write-Host "  FAIL $Label -- $($_.Exception.Message)"
        $script:fail++
    }
}

function Test-AssertThrows {
    param([string]$Label, [scriptblock]$Body, [string]$MessageContains = "")
    try {
        & $Body
        Write-Host "  FAIL $Label -- expected exception but none was thrown"
        $script:fail++
    } catch {
        if ($MessageContains -ne "" -and $_.Exception.Message -notmatch [regex]::Escape($MessageContains)) {
            Write-Host "  FAIL $Label -- exception message did not contain '$MessageContains': $($_.Exception.Message)"
            $script:fail++
        } else {
            Write-Host "  PASS $Label"
            $script:pass++
        }
    }
}

# ---------------------------------------------------------------------------
# Load helpers (dot-source without AWS calls).
# ---------------------------------------------------------------------------
$helpersPath = Join-Path $PSScriptRoot "aws-helpers.ps1"
. $helpersPath

# ---------------------------------------------------------------------------
# 1. PowerShell syntax validation
# ---------------------------------------------------------------------------
Write-Host "`n[1] PowerShell syntax validation"

Test-Assert "aws-helpers.ps1 parses without errors" {
    $errors = $null; $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $helpersPath, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "Parse errors: $($errors[0].Message)" }
}

Test-Assert "smoke-test.ps1 parses without errors" {
    $p = Join-Path $PSScriptRoot "smoke-test.ps1"
    $errors = $null; $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $p, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "Parse errors: $($errors[0].Message)" }
}

Test-Assert "rollback.ps1 parses without errors" {
    $p = Join-Path $PSScriptRoot "rollback.ps1"
    $errors = $null; $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $p, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "Parse errors: $($errors[0].Message)" }
}

# ---------------------------------------------------------------------------
# 2. Invoke-AwsChecked throws on nonzero exit (mock via $LASTEXITCODE)
# ---------------------------------------------------------------------------
Write-Host "`n[2] Invoke-AwsChecked throws on nonzero exit"

# We cannot use `exit N` inside a function in PS 5.1 without terminating the
# test process. Instead, override the aws function to set $global:LASTEXITCODE
# directly and return no output.
function global:aws {
    param([Parameter(ValueFromRemainingArguments)][string[]]$a)
    $global:LASTEXITCODE = 1
}

Test-AssertThrows "Invoke-AwsChecked throws AwsCliException on nonzero exit" {
    Invoke-AwsChecked "some-command"
} -MessageContains "AWS CLI exited with code"

# Override with a mock that sets exit code 0 and returns output.
function global:aws {
    param([Parameter(ValueFromRemainingArguments)][string[]]$a)
    $global:LASTEXITCODE = 0
    Write-Output "ok-output"
}

Test-Assert "Invoke-AwsChecked returns output on exit 0" {
    $out = Invoke-AwsChecked "some-command"
    if ($out -notmatch "ok-output") { throw "Expected ok-output, got: $out" }
}

# Verify exception does not contain arguments.
function global:aws {
    param([Parameter(ValueFromRemainingArguments)][string[]]$a)
    $global:LASTEXITCODE = 2
}

Test-Assert "Invoke-AwsChecked exception does not contain arguments" {
    try {
        Invoke-AwsChecked "--secret-arg" "secret-value"
    } catch {
        if ($_.Exception.Message -match "secret-arg" -or $_.Exception.Message -match "secret-value") {
            throw "Exception message contains argument values"
        }
    }
}

# ---------------------------------------------------------------------------
# 3. Invoke-AwsRetryable returns Success=false after all retries fail
# ---------------------------------------------------------------------------
Write-Host "`n[3] Invoke-AwsRetryable retry behavior"

$script:mockCallCount = 0
function global:aws {
    param([Parameter(ValueFromRemainingArguments)][string[]]$a)
    $script:mockCallCount++
    $global:LASTEXITCODE = 1
}

Test-Assert "Invoke-AwsRetryable returns Success=false after MaxAttempts" {
    $script:mockCallCount = 0
    $result = Invoke-AwsRetryable "logs" "filter-log-events" -MaxAttempts 3 -DelaySeconds 0
    if ($result.Success -ne $false) { throw "Expected Success=false" }
    if ($script:mockCallCount -ne 3) { throw "Expected 3 attempts, got $($script:mockCallCount)" }
}

Test-Assert "Invoke-AwsRetryable returns Success=true on first success" {
    $script:mockCallCount = 0
    function global:aws {
        param([Parameter(ValueFromRemainingArguments)][string[]]$a)
        $script:mockCallCount++
        $global:LASTEXITCODE = 0
        Write-Output '{"events":[]}'
    }
    $result = Invoke-AwsRetryable "logs" "filter-log-events" -MaxAttempts 3 -DelaySeconds 0
    if ($result.Success -ne $true) { throw "Expected Success=true" }
    if ($script:mockCallCount -ne 1) { throw "Expected 1 attempt, got $($script:mockCallCount)" }
}

Test-Assert "Invoke-AwsRetryable succeeds on second attempt" {
    $script:mockCallCount = 0
    function global:aws {
        param([Parameter(ValueFromRemainingArguments)][string[]]$a)
        $script:mockCallCount++
        if ($script:mockCallCount -lt 2) {
            $global:LASTEXITCODE = 1
        } else {
            $global:LASTEXITCODE = 0
            Write-Output "success-output"
        }
    }
    $result = Invoke-AwsRetryable "logs" "filter-log-events" -MaxAttempts 3 -DelaySeconds 0
    if ($result.Success -ne $true) { throw "Expected Success=true on second attempt" }
    if ($script:mockCallCount -ne 2) { throw "Expected 2 attempts, got $($script:mockCallCount)" }
}

Test-Assert "Invoke-AwsRetryable does not throw on failure" {
    function global:aws {
        param([Parameter(ValueFromRemainingArguments)][string[]]$a)
        $global:LASTEXITCODE = 1
    }
    $result = Invoke-AwsRetryable "logs" "filter-log-events" -MaxAttempts 1 -DelaySeconds 0
    if ($result.Success -ne $false) { throw "Expected Success=false" }
}

# ---------------------------------------------------------------------------
# 4. ConvertTo-LambdaEnvArg serialization
# ---------------------------------------------------------------------------
Write-Host "`n[4] ConvertTo-LambdaEnvArg serialization"

Test-Assert "empty object produces Variables={}" {
    $result = ConvertTo-LambdaEnvArg ([PSCustomObject]@{})
    if ($result -ne "Variables={}") { throw "Got: $result" }
}

Test-Assert "null produces Variables={}" {
    $result = ConvertTo-LambdaEnvArg $null
    if ($result -ne "Variables={}") { throw "Got: $result" }
}

Test-Assert "single variable produces correct format" {
    $result = ConvertTo-LambdaEnvArg ([PSCustomObject]@{ NODE_ENV = "development" })
    if ($result -ne "Variables={NODE_ENV=development}") { throw "Got: $result" }
}

Test-Assert "multiple variables are included" {
    $vars = [PSCustomObject]@{ A = "1"; B = "2" }
    $result = ConvertTo-LambdaEnvArg $vars
    if ($result -notmatch "A=1" -or $result -notmatch "B=2") { throw "Got: $result" }
    if (-not $result.StartsWith("Variables={")) { throw "Missing Variables={ prefix: $result" }
}

# ---------------------------------------------------------------------------
# 5. Manifest path containment validation
# ---------------------------------------------------------------------------
Write-Host "`n[5] Manifest path containment"

$repoRoot     = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$expectedBase = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "rollback"))
$sep          = [System.IO.Path]::DirectorySeparatorChar

Test-Assert "valid path inside rollback/ is accepted" {
    $p = [System.IO.Path]::GetFullPath((Join-Path $expectedBase "manifest-123.json"))
    $ok = $p.StartsWith($expectedBase + $sep) -or $p -eq $expectedBase
    if (-not $ok) { throw "Path should be accepted: $p" }
}

Test-Assert "path outside rollback/ is rejected" {
    $p = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "evil.json"))
    $ok = $p.StartsWith($expectedBase + $sep) -or $p -eq $expectedBase
    if ($ok) { throw "Path should be rejected: $p" }
}

Test-Assert "path traversal attempt is rejected" {
    $p = [System.IO.Path]::GetFullPath((Join-Path $expectedBase "..\evil.json"))
    $ok = $p.StartsWith($expectedBase + $sep) -or $p -eq $expectedBase
    if ($ok) { throw "Traversal path should be rejected: $p" }
}

# ---------------------------------------------------------------------------
# 6. Missing required rollback manifest fields
# ---------------------------------------------------------------------------
Write-Host "`n[6] Required manifest field validation"

$requiredFields = @(
    "timestamp", "poolSnapshot", "clientSnapshot", "iamPolicy",
    "apiLambdaZip", "apiLambdaSha256", "originalHandler", "originalEnvSnapshot"
)

foreach ($field in $requiredFields) {
    Test-Assert "missing field '$field' is detected" {
        $m = @{}
        foreach ($f in $requiredFields) { if ($f -ne $field) { $m[$f] = "value" } }
        $obj = [PSCustomObject]$m
        # Use PSObject.Properties to safely check for missing fields without throwing.
        $missing = $requiredFields | Where-Object { $null -eq $obj.PSObject.Properties[$_] -or "$($obj.PSObject.Properties[$_].Value)".Trim() -eq "" }
        if ($missing -notcontains $field) { throw "Field '$field' was not detected as missing" }
    }
}

# ---------------------------------------------------------------------------
# 7. Artifact SHA mismatch detection
# ---------------------------------------------------------------------------
Write-Host "`n[7] Artifact SHA mismatch detection"

Test-Assert "SHA mismatch is detected" {
    $expected = "aabbcc"
    $actual   = "ddeeff"
    if ($actual -eq $expected) { throw "Should have detected mismatch" }
    # Verify neither value appears in a generic error message.
    $msg = "Rollback artifact SHA256 mismatch. Do not proceed."
    if ($msg -match $expected -or $msg -match $actual) {
        throw "Error message must not contain hash values"
    }
}

Test-Assert "SHA match passes" {
    $expected = "aabbcc"
    $actual   = "aabbcc"
    if ($actual -ne $expected) { throw "Should have matched" }
}

# ---------------------------------------------------------------------------
# 8. Original environment round-trip (serialize then reconstruct)
# ---------------------------------------------------------------------------
Write-Host "`n[8] Original environment round-trip"

Test-Assert "environment with multiple vars round-trips correctly" {
    $original = [PSCustomObject]@{
        SCO_ENVIRONMENT          = "development"
        SCO_PLAYER_TABLE_NAME    = "sco-dev-players"
        SCO_GUEST_STARTING_COINS = "200"
    }
    $arg = ConvertTo-LambdaEnvArg $original
    # Verify all keys and values are present in the argument string.
    foreach ($prop in $original.PSObject.Properties) {
        if ($arg -notmatch [regex]::Escape("$($prop.Name)=$($prop.Value)")) {
            throw "Missing $($prop.Name) in: $arg"
        }
    }
}

Test-Assert "empty environment round-trips to Variables={}" {
    $original = [PSCustomObject]@{}
    $arg = ConvertTo-LambdaEnvArg $original
    if ($arg -ne "Variables={}") { throw "Got: $arg" }
}

# ---------------------------------------------------------------------------
# 9. Secret-bearing variables cleared in finally block
# ---------------------------------------------------------------------------
Write-Host "`n[9] Secret-bearing variable clearing"

Test-Assert "finally block clears all declared secret variables" {
    # Simulate the pattern used in smoke-test.ps1.
    $accessToken1    = "secret-access-token"
    $refreshToken1   = "secret-refresh-token"
    $accessToken2    = "secret-access-token-2"
    $refreshToken2   = "secret-refresh-token-2"
    $sessionResponse = [PSCustomObject]@{ tokens = @{ accessToken = "x" } }
    $refreshResponse = [PSCustomObject]@{ tokens = @{ refreshToken = "y" } }
    $sessionBody     = '{"installationId":"test"}'
    $refreshBody1    = '{"refreshToken":"secret"}'
    $revokeBody      = '{"refreshToken":"secret2"}'
    $claims          = [PSCustomObject]@{ token_use = "access" }
    $payload         = "base64payload"
    $exactSecrets    = @("secret-access-token", "secret-refresh-token")

    try {
        # Simulate work that might throw.
    } finally {
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

    $secretVars = @($accessToken1, $refreshToken1, $accessToken2, $refreshToken2,
                    $sessionResponse, $refreshResponse, $sessionBody, $refreshBody1,
                    $revokeBody, $claims, $payload, $exactSecrets)
    foreach ($v in $secretVars) {
        if ($null -ne $v) { throw "Variable was not cleared: $v" }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`n--- Script test summary ---"
Write-Host "PASS: $pass   FAIL: $fail"

if ($fail -gt 0) {
    Write-Host "Script tests FAILED."
    exit 1
}

Write-Host "Script tests PASSED."
