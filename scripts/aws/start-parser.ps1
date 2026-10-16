[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
& node (Join-Path $PSScriptRoot 'configure-parser.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Parser configuration failed.' }
& docker image inspect 'cortex-parser:aws-local' *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Building Docling and its models. The first build may take several minutes.'
    & docker build --tag 'cortex-parser:aws-local' (Join-Path $root 'parser')
    if ($LASTEXITCODE -ne 0) { throw 'Parser image build failed.' }
}
Write-Host 'Starting the AWS test parser on localhost:8090. Keep this terminal open; Ctrl+C stops it.'
& docker run --rm --name 'cortex-parser-aws' --publish '127.0.0.1:8090:8090' --memory '4g' --cpus '4' --cap-drop 'ALL' --security-opt 'no-new-privileges' --env-file (Join-Path $PSScriptRoot '.local/parser.env') 'cortex-parser:aws-local'
if ($LASTEXITCODE -ne 0) { throw 'Parser stopped with an error. Check Docker and available memory.' }
