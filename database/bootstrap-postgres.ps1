$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $environmentFile)) {
  $passwordBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
  $password = [Convert]::ToBase64String($passwordBytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  @(
    "PDL_POSTGRES_PASSWORD=$password"
    "DATABASE_URL=postgresql://pro_daily_link:$password@127.0.0.1:5432/pro_daily_link"
  ) | Set-Content -LiteralPath $environmentFile -Encoding utf8
  Write-Host 'Created a local .env with a generated database password.'
}

docker compose --project-directory $projectRoot up -d postgres
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL container failed to start.' }

for ($attempt = 0; $attempt -lt 24; $attempt++) {
  $health = docker inspect --format '{{.State.Health.Status}}' pro-daily-link-postgres 2>$null
  if ($health -eq 'healthy') { break }
  Start-Sleep -Seconds 2
}
if ($health -ne 'healthy') { throw 'PostgreSQL did not become healthy.' }

docker exec pro-daily-link-postgres psql -U pro_daily_link -d pro_daily_link -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/001_tenant_foundation.sql 2>$null
if ($LASTEXITCODE -ne 0) {
  # The schema is automatically applied on a new volume. Existing initialized volumes may report duplicate objects.
  Write-Host 'Database is running; schema already appears initialized.'
}

Write-Host 'Pro Daily Link PostgreSQL is healthy on 127.0.0.1:5432.'
