[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$backendRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (Test-Path -LiteralPath (Join-Path $backendRoot '.env.aws')) { throw '.env.aws already exists. Edit that file to update its settings; this script will not overwrite it.' }
function Read-LocalSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
Write-Host 'This writes ignored LOCAL configuration files. Credentials stay on your computer.'
Write-Host 'The existing local OpenAI/parser settings are reused; Supabase credentials are not copied.'
$settings = @{
    databasePassword = Read-LocalSecret 'NEW cortex_postgrest password (not the RDS postgres master password)'
    clientSecret = Read-LocalSecret 'Cognito cortex app client secret'
}
$previousOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $settings | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'write-local-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not write the local AWS configuration.' }
} finally { $settings.Clear(); $OutputEncoding = $previousOutputEncoding }
