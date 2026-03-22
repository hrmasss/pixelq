param(
  [string]$OutputName = "pixelq-desktop-0.1.0-alpha"
)

$ErrorActionPreference = "Stop"

$wails = Join-Path $env:USERPROFILE "go\bin\wails.exe"
if (-not (Test-Path $wails)) {
  throw "Wails CLI not found at $wails"
}

Push-Location $PSScriptRoot
try {
  pnpm install --dir frontend
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

  pnpm --dir frontend run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

  & $wails build -trimpath -o $OutputName
  if ($LASTEXITCODE -ne 0) { throw "wails build failed" }

  $binDir = Join-Path $PSScriptRoot "build\bin"
  $rawOutput = Join-Path $binDir $OutputName
  $exeOutput = Join-Path $binDir "$OutputName.exe"
  if (Test-Path $rawOutput) {
    if (Test-Path $exeOutput) {
      Remove-Item -Force $exeOutput
    }
    Move-Item -Force $rawOutput $exeOutput
  }

  Write-Host ""
  Write-Host "Standalone desktop build ready in build\bin\$OutputName.exe"
} finally {
  Pop-Location
}
