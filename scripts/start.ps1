# Buurtradar starten met Python op Windows (zonder Docker).
# Makkelijkst: dubbelklik start.bat in de projectmap. Poort kiezen: start.bat 8081
# De eerste keer maakt dit script config.yaml en een Python-omgeving aan; daarna start het direct.
param([int]$Port = 8080)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "config.yaml")) {
    Copy-Item "config.example.yaml" "config.yaml"
    Write-Host "config.yaml aangemaakt (pas die gerust aan)."
}

$venv = "app\.venv"
if (-not (Test-Path "$venv\Scripts\python.exe")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { $py = "py"; $pyArgs = @("-3") }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = "python"; $pyArgs = @() }
    else {
        Write-Host "Python niet gevonden. Installeer Python 3.11 of nieuwer via https://www.python.org"
        Write-Host "en vink bij de installatie 'Add Python to PATH' aan."
        exit 1
    }
    Write-Host "Eerste keer: Python-omgeving aanmaken..."
    & $py @pyArgs -m venv $venv
}

# Pakketten (opnieuw) installeren als requirements.txt nieuw of veranderd is.
$hash = (Get-FileHash "app\requirements.txt").Hash
$stamp = "$venv\.requirements"
if (-not (Test-Path $stamp) -or (Get-Content $stamp) -ne $hash) {
    Write-Host "Pakketten installeren (duurt de eerste keer een minuut)..."
    & "$venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
    & "$venv\Scripts\python.exe" -m pip install --quiet -r app\requirements.txt
    if ($LASTEXITCODE -ne 0) { Write-Host "Installeren mislukt."; exit 1 }
    Set-Content $stamp $hash
}

Write-Host ""
Write-Host "Buurtradar draait op  http://localhost:$Port   (stoppen: Ctrl+C)"
Write-Host ""
Set-Location app
$env:SIRENE_CONFIG = "../config.yaml"
$env:SIRENE_DB = "./buurtradar.db"
Start-Job { Start-Sleep 4; Start-Process "http://localhost:$using:Port" } | Out-Null
& ".venv\Scripts\python.exe" -m uvicorn --factory sirene.main:app --port $Port
