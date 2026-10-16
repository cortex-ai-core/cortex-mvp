[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$sqlPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'configure-rds.sql')).Path
$certificatePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../migration/.local/us-east-2-bundle.pem')).Path
Write-Host 'Configuring the two server-only backend roles in the restored cortex RDS database.'
Write-Host 'Enter the RDS postgres password from Secrets Manager at the first prompt.'
Write-Host 'Then choose and confirm a NEW password for cortex_postgrest. Save it for configure-local.ps1.'
$dockerArguments = @(
    'run', '--rm', '-it',
    '--mount', "type=bind,source=$certificatePath,target=/rds-ca.pem,readonly",
    '--mount', "type=bind,source=$sqlPath,target=/configure.sql,readonly",
    '--env', 'PGSSLMODE=verify-full', '--env', 'PGSSLROOTCERT=/rds-ca.pem', '--env', 'PGCONNECT_TIMEOUT=15',
    'postgres:18', 'psql', '--host', 'cortex-rds.cvcm2qq6u67z.us-east-2.rds.amazonaws.com',
    '--port', '5432', '--username', 'postgres', '--dbname', 'cortex', '--password', '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1', '--single-transaction', '--file', '/configure.sql',
    '--command', '\password cortex_postgrest'
)
& docker @dockerArguments
if ($LASTEXITCODE -ne 0) { throw 'RDS backend setup failed; the transaction was rolled back.' }
Write-Host 'RDS backend roles configured. Supabase was not accessed.'
