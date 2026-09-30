# Buurtradar bijwerken op Windows: nieuwste code ophalen en (als die veranderd is) opnieuw starten.
# Gebruik (PowerShell, vanuit de projectmap):  powershell -ExecutionPolicy Bypass -File scripts\update.ps1
# Je config.yaml, .env en gegevens blijven staan: die zitten niet in git.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$before = git rev-parse HEAD
git pull --ff-only --quiet
if ($LASTEXITCODE -ne 0) { Write-Error "git pull mislukt (lokale wijzigingen?)"; exit 1 }
$after = git rev-parse HEAD

if ($before -eq $after) {
    Write-Host "Buurtradar is al up-to-date ($(git log -1 --format='%h %s'))."
    exit 0
}

Write-Host "Bijgewerkt:"
git log --oneline "$before..$after"

if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose up -d --build buurtradar
    Write-Host "Container opnieuw gebouwd en gestart."
} elseif (Test-Path "app\.venv") {
    & "app\.venv\Scripts\pip.exe" install --quiet -r app\requirements.txt
    Write-Host "Pakketten bijgewerkt. Herstart de server om de nieuwe versie te gebruiken."
}
