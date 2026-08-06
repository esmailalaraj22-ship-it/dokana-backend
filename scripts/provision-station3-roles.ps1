[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$environmentPath = Join-Path $repositoryRoot '.env'
$helperPath = Join-Path $repositoryRoot 'scripts\provision-station3-roles.ts'
$tsxPath = Join-Path $repositoryRoot 'node_modules\.bin\tsx.cmd'

$migrationPasswordSecure = $null
$authenticationPasswordSecure = $null
$migrationPasswordPlain = $null
$authenticationPasswordPlain = $null

try {
    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        throw 'The local .env file is required.'
    }

    if (-not (Test-Path -LiteralPath $tsxPath -PathType Leaf)) {
        throw 'Install locked project dependencies before provisioning.'
    }

    & git -C $repositoryRoot check-ignore --quiet -- .env 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'The local .env file is not ignored by Git.'
    }

    $migrationPasswordSecure = Read-Host `
        'Enter the new dokana_migration_login password' `
        -AsSecureString
    $authenticationPasswordSecure = Read-Host `
        'Enter the new dokana_auth_login password' `
        -AsSecureString

    $migrationPasswordPlain = [System.Net.NetworkCredential]::new(
        '',
        $migrationPasswordSecure
    ).Password
    $authenticationPasswordPlain = [System.Net.NetworkCredential]::new(
        '',
        $authenticationPasswordSecure
    ).Password

    [Environment]::SetEnvironmentVariable(
        'DOKANA_STATION3_MIGRATION_PASSWORD',
        $migrationPasswordPlain,
        'Process'
    )
    [Environment]::SetEnvironmentVariable(
        'DOKANA_STATION3_AUTH_PASSWORD',
        $authenticationPasswordPlain,
        'Process'
    )

    Push-Location $repositoryRoot
    try {
        & $tsxPath $helperPath 2>$null
        $helperExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($helperExitCode -ne 0) {
        throw 'The role provisioning helper did not complete.'
    }

    Write-Output 'OK - Station 3 database roles provisioned and local environment updated'
    exit 0
}
catch {
    Write-Output 'FAIL - Station 3 role provisioning did not complete'
    exit 1
}
finally {
    [Environment]::SetEnvironmentVariable(
        'DOKANA_STATION3_MIGRATION_PASSWORD',
        $null,
        'Process'
    )
    [Environment]::SetEnvironmentVariable(
        'DOKANA_STATION3_AUTH_PASSWORD',
        $null,
        'Process'
    )

    $migrationPasswordPlain = $null
    $authenticationPasswordPlain = $null

    if ($null -ne $migrationPasswordSecure) {
        $migrationPasswordSecure.Dispose()
    }
    if ($null -ne $authenticationPasswordSecure) {
        $authenticationPasswordSecure.Dispose()
    }
}
