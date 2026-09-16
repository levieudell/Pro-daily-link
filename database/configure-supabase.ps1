$ErrorActionPreference = 'Stop'

function ConvertFrom-SecureValue {
  param([Security.SecureString]$Value)
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$projectUrl = 'https://wbyhzgrurggzgbyjftkr.supabase.co'
$secretKey = ConvertFrom-SecureValue (Read-Host 'Paste the NEW Supabase secret key, then press Enter' -AsSecureString)
$databaseUrl = ConvertFrom-SecureValue (Read-Host 'Paste the Session/Shared Pooler DATABASE_URL (port 5432), then press Enter' -AsSecureString)

if (-not $secretKey.StartsWith('sb_secret_')) {
  throw 'The secret key must begin with sb_secret_.'
}
if ($databaseUrl -notmatch '^postgres(ql)?://' -or $databaseUrl -notmatch ':5432/') {
  throw 'DATABASE_URL must be a PostgreSQL connection URL using port 5432.'
}

@(
  "SUPABASE_URL=$projectUrl"
  "SUPABASE_SECRET_KEY=$secretKey"
  "DATABASE_URL=$databaseUrl"
) | Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\.env.local') -Encoding utf8

Write-Host 'Saved securely to .env.local. Values were not displayed.' -ForegroundColor Green
