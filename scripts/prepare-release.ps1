param(
  [string]$Version = "0.1.1-alpha"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "releases\$Version"
$desktopName = "pixelq-desktop-$Version"
$extensionZip = "pixelq-extension-$Version.zip"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

Push-Location $root
try {
  & ".\app\build-release.ps1" -OutputName $desktopName
  Copy-Item -Force ".\app\build\bin\$desktopName.exe" (Join-Path $releaseDir "$desktopName.exe")

  $tempExtensionDir = Join-Path $env:TEMP "pixelq-extension-$Version"
  if (Test-Path $tempExtensionDir) {
    Remove-Item -Recurse -Force $tempExtensionDir
  }
  New-Item -ItemType Directory -Force -Path $tempExtensionDir | Out-Null
  Copy-Item -Recurse -Force ".\extension\*" $tempExtensionDir

  $zipPath = Join-Path $releaseDir $extensionZip
  if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
  }
  Compress-Archive -Path (Join-Path $tempExtensionDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

  Write-Host ""
  Write-Host "Release artifacts prepared in $releaseDir"
  Write-Host " - $desktopName.exe"
  Write-Host " - $extensionZip"
} finally {
  Pop-Location
}
