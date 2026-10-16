[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:8081'
Write-Host 'Testing the separate AWS backend on localhost:8081. This logs in and performs GET requests only.'
$email = Read-Host 'Cognito test user email'
$secure = Read-Host 'Permanent Cognito test user password' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = $null
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $body = @{ email = $email; password = $password } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/auth/login" -ContentType 'application/json' -Body $body
    $token = $login.token
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'Backend did not return a session token.' }
    $headers = @{ Authorization = "Bearer $token" }
    $documents = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/documents" -Headers $headers
    Write-Host "AWS backend login passed for $($login.user.email), role $($login.user.role), namespace $($login.user.namespace)."
    Write-Host 'Protected document listing passed. No passwords or tokens were printed or saved.'
} catch {
    # HTTP responses contain application errors only; never emit request bodies or tokens.
    Write-Host 'AWS backend check failed. Check the backend terminal for the error and verify RDS/PostgREST and Cognito settings.'
    throw 'AWS backend login or protected document listing failed.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $password = $null; $body = $null; $token = $null; $login = $null; $headers = $null
}
