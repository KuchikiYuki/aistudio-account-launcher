param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Protect', 'Unprotect')]
    [string]$Operation
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Security
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('aistudio-account-launcher:key:v1')
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Operation -eq 'Protect') {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.value)
        try {
            $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
            [Console]::Write([Convert]::ToBase64String($result))
        } finally {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    } else {
        $protected = [Convert]::FromBase64String([string]$request.value)
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, $scope)
        try {
            [Console]::Write([System.Text.Encoding]::UTF8.GetString($result))
        } finally {
            [Array]::Clear($result, 0, $result.Length)
        }
    }
} catch {
    [Console]::Error.Write('Windows credential protection failed.')
    exit 1
}
