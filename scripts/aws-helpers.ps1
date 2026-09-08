#Requires -Version 5.1
# scripts/aws-helpers.ps1
# Shared helpers for deployment, smoke test, and rollback scripts.
# Dot-source this file: . .\scripts\aws-helpers.ps1
#
# NEVER print sensitive arguments, responses, stderr content, or $_ from AWS calls.

# Thrown by Invoke-AwsChecked on nonzero exit. Contains only the exit code.
# Never contains AWS arguments, response bodies, tokens, or environment values.
class AwsCliException : System.Exception {
    [int]$ExitCode
    AwsCliException([int]$code) : base("AWS CLI exited with code $code") {
        $this.ExitCode = $code
    }
}

# Invoke an aws CLI command and throw AwsCliException on any nonzero exit code.
# $ErrorActionPreference does NOT convert native exe exit codes to errors in PS 5.1.
# Every AWS call in deployment/rollback/smoke scripts must use this wrapper.
# Never prints arguments, response bodies, or stderr content.
function Invoke-AwsChecked {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $output = & aws @Arguments 2>&1
    $code   = $LASTEXITCODE   # capture immediately before any other statement
    if ($code -ne 0) {
        throw [AwsCliException]::new($code)
    }
    return $output
}

# Invoke-AwsChecked and parse the JSON result.
function Invoke-AwsJson {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $raw = Invoke-AwsChecked @Arguments
    return $raw | ConvertFrom-Json
}

# Invoke an aws CLI command with bounded retries, returning a result object.
# Designed for eventually-consistent reads (e.g. CloudWatch log delivery).
# Returns: [PSCustomObject]@{ Success=$true; Output=<string> }
#       or [PSCustomObject]@{ Success=$false; Output=$null }
# Never throws. Never prints arguments, response bodies, or stderr content.
# $LASTEXITCODE is checked immediately after each attempt.
function Invoke-AwsRetryable {
    param(
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments,
        [int]$MaxAttempts   = 6,
        [int]$DelaySeconds  = 5
    )
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        if ($i -gt 1) { Start-Sleep -Seconds $DelaySeconds }
        $raw  = & aws @Arguments 2>&1
        $code = $LASTEXITCODE   # capture immediately
        if ($code -eq 0) {
            return [PSCustomObject]@{ Success = $true; Output = ($raw -join "`n") }
        }
        # else: retry silently
    }
    return [PSCustomObject]@{ Success = $false; Output = $null }
}

# Serialize Lambda Environment.Variables to the --environment argument string.
# Input: a PSCustomObject whose properties are the variable names/values.
# Output: a string like "Variables={KEY1=val1,KEY2=val2}" or "Variables={}" for empty.
# Never prints values.
function ConvertTo-LambdaEnvArg {
    param([object]$Variables)
    if ($null -eq $Variables) { return "Variables={}" }
    $props = @($Variables.PSObject.Properties)
    if ($props.Count -eq 0) { return "Variables={}" }
    $pairs = $props | ForEach-Object { "$($_.Name)=$($_.Value)" }
    return "Variables={$($pairs -join ',')}"
}

# Assert a condition; increment $script:pass or $script:fail.
function Assert-Equal {
    param([string]$Label, $Actual, $Expected)
    if ($Actual -eq $Expected) {
        Write-Host "  PASS $Label"
        $script:pass++
    } else {
        Write-Host "  FAIL $Label -- expected '$Expected', got '$Actual'"
        $script:fail++
    }
}

function Assert-NotEmpty {
    param([string]$Label, $Value)
    if ($null -ne $Value -and "$Value".Length -gt 0) {
        Write-Host "  PASS $Label"
        $script:pass++
    } else {
        Write-Host "  FAIL $Label -- value was null or empty"
        $script:fail++
    }
}

function Assert-Match {
    param([string]$Label, [string]$Value, [string]$Pattern)
    if ($Value -match $Pattern) {
        Write-Host "  PASS $Label"
        $script:pass++
    } else {
        Write-Host "  FAIL $Label -- value did not match expected pattern"
        $script:fail++
    }
}

function Assert-True {
    param([string]$Label, [bool]$Value)
    if ($Value) {
        Write-Host "  PASS $Label"
        $script:pass++
    } else {
        Write-Host "  FAIL $Label"
        $script:fail++
    }
}

# Invoke-WebRequest wrapper compatible with PS 5.1 (no -SkipHttpErrorCheck).
# Returns a minimal object with StatusCode regardless of HTTP status.
# Never prints response body or request details.
function Invoke-HttpRequest {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        [string]$Body = $null,
        [string]$ContentType = $null
    )
    $params = @{ Uri = $Uri; Method = $Method; UseBasicParsing = $true }
    if ($Headers.Count -gt 0) { $params.Headers = $Headers }
    if ($null -ne $Body -and $Body -ne '')        { $params.Body = $Body }
    if ($null -ne $ContentType -and $ContentType -ne '') { $params.ContentType = $ContentType }
    try {
        $r = Invoke-WebRequest @params
        return [PSCustomObject]@{ StatusCode = [int]$r.StatusCode; Content = $r.Content }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            return [PSCustomObject]@{ StatusCode = [int]$resp.StatusCode; Content = $null }
        }
        throw
    }
}

# Compute SHA-256 of a UTF-8 string (for fixture manifest key computation).
function Get-Sha256String {
    param([string]$Value)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash  = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
}
