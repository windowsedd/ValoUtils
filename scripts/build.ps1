# Builds the signed release installer locally.
#
# `tauri build` refuses to bundle without the updater private key, and the key
# has to be in the environment of the shell running the CLI - a .env file only
# reaches Vite. This exports it for this process only and runs `bun run build`.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1
#
# The key password defaults to empty. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# beforehand if your key has one.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$keyPath = Join-Path $root "src-tauri\valoutils.key"

if (-not (Test-Path $keyPath)) {
    Write-Error "Signing key not found at $keyPath. Generate one with: bun run tauri signer generate -w src-tauri\valoutils.key (see README, 'Updater signing key')."
}

$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    # `$env:X = ""` deletes the variable instead, and without it the CLI stops
    # to prompt for the password. Win32 keeps an empty value, and child
    # processes inherit it.
    Add-Type -Namespace ValoUtils -Name Env -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool SetEnvironmentVariable(string name, string value);
'@
    [void][ValoUtils.Env]::SetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
}

Push-Location $root
try {
    bun run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

$bundle = Join-Path $root "src-tauri\target\release\bundle\nsis"
Write-Host ""
Write-Host "Build complete:"
Write-Host "  App:       $(Join-Path $root 'src-tauri\target\release\valoutils.exe')"
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
Get-ChildItem $bundle -Filter "*_${version}_*-setup.exe*" | ForEach-Object { Write-Host "  Installer: $($_.FullName)" }
