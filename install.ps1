# Kimi Code Desktop - one-command installer (Windows)
#
#   irm https://raw.githubusercontent.com/grafizum/kimi-cli-desktop/master/install.ps1 | iex
#
# Downloads the latest release (portable single-file exe) from GitHub and
# installs it into %LOCALAPPDATA%\Programs\Kimi Code Desktop, then creates
# Start Menu (and optional Desktop) shortcuts. No admin rights needed.
#
# NOTE: this script never calls `exit` - `irm | iex` runs it inside YOUR
# PowerShell session, and `exit` would close your whole console window.
# Fatal errors are printed in red and the script simply returns.
#
# Saved as UTF-8 *with* BOM on purpose: Windows PowerShell 5.1 assumes ANSI for
# BOM-less files and would print the check marks below as mojibake.
#
# Options (first run):
#   $env:KCD_SKIP_DESKTOP_SHORTCUT = "1"   # don't create a Desktop shortcut
#   $env:KCD_INSTALL_DIR = "D:\Apps\Kimi"  # custom install location

$ErrorActionPreference = "Stop"
# The progress bar makes Invoke-WebRequest ~10x slower on Windows PowerShell 5.1.
$OldProgressPreference = $ProgressPreference
$ProgressPreference    = "SilentlyContinue"

$Repo        = "grafizum/kimi-cli-desktop"
$Api         = "https://api.github.com/repos/$Repo/releases/latest"
$ReleasePage = "https://github.com/$Repo/releases/latest"
$UserAgent   = "kimi-cli-desktop-installer"

$InstallDir = if ($env:KCD_INSTALL_DIR) { $env:KCD_INSTALL_DIR }
              else { Join-Path $env:LOCALAPPDATA "Programs\Kimi Code Desktop" }
$ExeName    = "Kimi-Code-Desktop.exe"
$ExePath    = Join-Path $InstallDir $ExeName

function Say  ($m) { Write-Host "==>" $m }
function Warn ($m) { Write-Host "!! " $m -ForegroundColor Yellow }
function Info ($m) { Write-Host "==>" $m -ForegroundColor DarkGray }
function Ok   ($m) { Write-Host "✔ $m" -ForegroundColor Green }

# The app is a shell around the 'kimi' CLI - without it there is nothing to
# drive. Detect it even when this session's PATH is stale (fresh installs
# only update the registry PATH, not running processes).
function Test-KimiCli {
    if (Get-Command "kimi" -ErrorAction SilentlyContinue) { return $true }
    if (Test-Path (Join-Path $env:APPDATA "npm\kimi.cmd")) { return $true }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
        foreach ($dir in ($userPath -split ";")) {
            if (-not $dir) { continue }
            if (Test-Path (Join-Path $dir "kimi.cmd")) { return $true }
            if (Test-Path (Join-Path $dir "kimi.exe")) { return $true }
        }
    }
    return $false
}

function Ensure-KimiCli {
    if (Test-KimiCli) { Say "Kimi CLI found - the app is ready to use."; return }

    Warn "The 'kimi' CLI (the engine this app runs) is not installed yet."
    $answer = "n"
    if    ($env:KCD_INSTALL_CLI -eq "1") { $answer = "y" }
    elseif ($env:KCD_INSTALL_CLI -eq "0") { $answer = "n" }
    else {
        try { $answer = (Read-Host "Install it now? [Y/n]").Trim() } catch { $answer = "n" }
    }
    if ($answer -match "^(n|no)$") {
        Say "Skipping for now. Install it any time with:"
        Say "  irm https://code.kimi.com/kimi-code/install.ps1 | iex"
        return
    }

    Say "Installing the Kimi CLI ..."
    try {
        # Run the official installer in a child PowerShell so its own `exit`
        # statements can never close YOUR console (this script runs via iex).
        $cliScript = Invoke-RestMethod -Uri "https://code.kimi.com/kimi-code/install.ps1" -Headers @{ "User-Agent" = $UserAgent } -ErrorAction Stop
        $null = Start-Process -Wait -PassThru -NoNewWindow powershell.exe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cliScript)
    } catch {
        Warn "Could not run the CLI installer: $($_.Exception.Message)"
        Warn "Install it manually:  irm https://code.kimi.com/kimi-code/install.ps1 | iex"
        return
    }
    if (Test-KimiCli) { Ok "Kimi CLI installed - everything is ready." }
    else { Info "CLI installed. Open a NEW terminal (or just launch the app) so PATH changes take effect." }
}

function Main {
    Say "Resolving the latest release of $Repo ..."

    # Windows PowerShell 5.1 can default to TLS 1.0/1.1; GitHub needs TLS 1.2+.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $headers = @{ "User-Agent" = $UserAgent }
    # Failures here bubble up to the wrapper below, which prints the real reason.
    $release = Invoke-RestMethod -Uri $Api -Headers $headers -ErrorAction Stop

    $asset = $release.assets |
        Where-Object { $_.name -match "portable\.exe$" -and $_.name -match "x64" } |
        Select-Object -First 1
    if (-not $asset) {
        $asset = $release.assets | Where-Object { $_.name -match "portable\.exe$" } | Select-Object -First 1
    }
    if (-not $asset) {
        throw "No portable build in the latest release ($($release.tag_name)). Install manually from $ReleasePage"
    }

    $Version = $release.tag_name
    Say "Found $($asset.name) ($Version)"

    # --- Download (with one automatic retry) --------------------------------
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $tmp = Join-Path $env:TEMP $asset.name

    Say "Downloading $($asset.name) (~100 MB - may take a minute) ..."
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing -UserAgent $UserAgent -ErrorAction Stop
            break
        } catch {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if ($attempt -ge 2) { throw "Download failed: $($_.Exception.Message)" }
            Say "Download hiccup - retrying ..."
        }
    }

    # Sanity check: an error page, or a file quarantined by antivirus, is not
    # a ~100 MB exe.
    if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 50MB) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw "The downloaded file is missing or too small - your antivirus may have quarantined it. Whitelist the app, or download it manually from $ReleasePage"
    }

    # --- Install (portable exe + shortcuts) ----------------------------------
    try {
        Move-Item -Force $tmp $ExePath
    } catch {
        throw "Could not place $ExePath - is Kimi Code Desktop still running? Close it and re-run the installer."
    }

    # Start Menu shortcut
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
    $lnk = Join-Path $startMenu "Kimi Code Desktop.lnk"
    $shell = New-Object -ComObject "WScript.Shell"
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $ExePath
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation = $ExePath
    $sc.Description = "Desktop shell for the Kimi Code CLI"
    $sc.Save()

    # Optional Desktop shortcut (safest to skip on locked-down desktops)
    if ($env:KCD_SKIP_DESKTOP_SHORTCUT -ne "1") {
        try {
            $desktop = [Environment]::GetFolderPath("Desktop")
            if ($desktop) {
                $dlnk = Join-Path $desktop "Kimi Code Desktop.lnk"
                $dc = $shell.CreateShortcut($dlnk)
                $dc.TargetPath = $ExePath
                $dc.WorkingDirectory = $InstallDir
                $dc.IconLocation = $ExePath
                $dc.Save()
            }
        } catch { Warn "Could not create a Desktop shortcut (skipped)." }
    }

    Say "Installed: $ExePath"
    Ensure-KimiCli
    Write-Host ""
    Ok "Kimi Code Desktop was installed successfully."
    Info "Launch it from your Start Menu or Desktop shortcut."
    Info "First launch may show a SmartScreen prompt - choose 'More info -> Run anyway' (open-source app, see the README)."
}

try {
    Main
} catch {
    Write-Host ""
    Write-Host "!! Install failed:" -ForegroundColor Red
    Write-Host "!! $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.InnerException -and $_.Exception.InnerException.Message) {
        Write-Host "!!   $($_.Exception.InnerException.Message)" -ForegroundColor Red
    }
    if ($_.Exception.Message -match "403") {
        Write-Host "!!   (GitHub rate-limits unauthenticated API calls; this usually clears within the hour.)" -ForegroundColor DarkGray
    }
    Write-Host "!! You can also install manually: $ReleasePage" -ForegroundColor Red
} finally {
    $ProgressPreference = $OldProgressPreference
}
