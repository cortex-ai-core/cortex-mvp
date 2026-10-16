[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$configurationPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '.local/postgrest.env')).Path
$certificatePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../migration/.local/us-east-2-bundle.pem')).Path
Write-Host 'Starting the RDS database API on localhost:3001. Keep this terminal open; Ctrl+C stops it.'
$dockerArguments = @(
    'run', '--rm', '--name', 'cortex-rds-api', '--publish', '127.0.0.1:3001:3000',
    '--env-file', $configurationPath,
    '--mount', "type=bind,source=$certificatePath,target=/rds-ca.pem,readonly",
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    'postgrest/postgrest:v16.4'
)
& docker @dockerArguments
if ($LASTEXITCODE -ne 0) { throw 'RDS database API stopped with an error. Check Docker, the backend-role password and RDS network access.' }
