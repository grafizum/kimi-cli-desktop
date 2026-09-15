# Kimi Code Desktop - one-command installer (Windows)
#
#   irm https://raw.githubusercontent.com/grafizum/kimi-cli-desktop/main/install.ps1 | iex
#
# Downloads the latest release from GitHub and installs it SILENTLY via the
# NSIS Setup: the app lands in %LOCALAPPDATA%\Programs\Kimi Code Desktop,
# gets a Start Menu entry (search for "Kimi Code Desktop") and an uninstaller.
#
# NOTE: this script never calls `exit` - `irm | iex` runs it inside YOUR
# PowerShell session, and `exit` would close your whole console window.
# Fatal errors are printed in red and the script simply returns.
#
# ENCODING: this file is plain ASCII *without* a BOM on purpose. Windows
# PowerShell 5.1 mishandles a BOM that arrives through `irm | iex` (the parser
# then executes the first comment line as a broken command). Keep it ASCII;
# the "check marks" below are plain text so no Unicode is needed.
#
# Options (first run):
#   $env:KCD_INSTALL_DIR = "D:\Apps\Kimi"   # custom install location
#   $env:KCD_INSTALL_CLI = "1"/"0"          # force skip/auto for the CLI prompt

$ErrorActionPreference = "Stop"
# Note: do NOT set $ProgressPreference to SilentlyContinue here - it would
# suppress Write-Progress and hide the download bar below. The old reason
# (Invoke-WebRequest's progress rendering being 10x slower on PS 5.1) is gone:
# the download now streams through HttpClient and draws its own bar.

$Repo        = "grafizum/kimi-cli-desktop"
$Api         = "https://api.github.com/repos/$Repo/releases/latest"
$ReleasePage = "https://github.com/$Repo/releases/latest"
$UserAgent   = "kimi-cli-desktop-installer"

# The NSIS Setup (electron-builder) installs into Programs\kimi-cli-desktop -
# derived from the package name, NOT the product name. The portable fallback
# below uses the friendly folder instead.
$SetupDir   = if ($env:KCD_INSTALL_DIR) { $env:KCD_INSTALL_DIR.TrimEnd("\") }
              else { Join-Path $env:LOCALAPPDATA "Programs\kimi-cli-desktop" }
$ExeName    = "Kimi Code Desktop.exe"
$ExePath    = Join-Path $SetupDir $ExeName
$LegacyDir  = Join-Path $env:LOCALAPPDATA "Programs\Kimi Code Desktop"

function Say  ($m) { Write-Host "==>" $m }
function Warn ($m) { Write-Host "!!" $m -ForegroundColor Yellow }
function Info ($m) { Write-Host "==>" $m -ForegroundColor DarkGray }
function Ok   ($m) { Write-Host "[OK]" $m -ForegroundColor Green }

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

function Clean-Err($err) {
    # .NET method-call failures arrive wrapped ("Exception calling ..."),
    # which reads like a crash. Print only the actual reason underneath.
    $inner = $err.Exception.InnerException
    if ($inner -and $inner.Message) { return $inner.Message }
    return $err.Exception.Message
}

function Write-DownloadBar($read, $total, $elapsedSec) {
    # A bar that is really IN the console output - curl-style, redrawn in
    # place with carriage returns (Write-Progress renders in a transient pane
    # that vanishes when it completes and never reaches redirected output).
    # Speed and ETA make even a slow connection visibly alive.
    $width = 26
    $extra = ""
    if ($elapsedSec -ge 1) {
        $speed = $read / $elapsedSec
        if ($speed -gt 0) {
            $extra = "   {0,5:N1} MB/s" -f ($speed / 1MB)
            if ($total -and $read -lt $total) {
                $eta = [TimeSpan]::FromSeconds([math]::Ceiling(($total - $read) / $speed))
                $extra += "  ETA {0:hh\:mm\:ss}" -f $eta
            }
        }
    }
    if ($total) {
        $pct  = [math]::Min(100, [int](100 * $read / $total))
        $fill = [int]($width * $pct / 100)
        $bar  = ("#" * $fill) + ("-" * ($width - $fill))
        $line = "[{0}] {1,3}%  {2,6:N1}/{3,6:N1} MB{4}" -f $bar, $pct, ($read / 1MB), ($total / 1MB), $extra
    } else {
        # Server sent no Content-Length: show the running counter instead.
        $line = "{0,7:N1} MB{1}" -f ($read / 1MB), $extra
    }
    Write-Host ("`r" + $line.PadRight($width + 46)) -NoNewline
}

function Download-WithProgress($url, $dest) {
    # Streams the response in 512 KB chunks and redraws the bar per chunk.
    # Plain Invoke-WebRequest buffers everything and would sit silent for a
    # minute on a ~100 MB asset.
    # PS 5.1 does not load this assembly by default.
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd($UserAgent)
    try {
        # ResponseHeadersRead is the whole point of this function: GetAsync
        # returns as soon as the headers arrive and the body is streamed
        # below, read by read. The default option (ResponseContentRead)
        # silently buffered the entire ~100 MB first - the bar sat frozen on
        # the "Downloading ..." line and then jumped to 100% in an instant,
        # because the loop only drained an already-complete memory buffer.
        $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode) for $url" }
        $total  = $resp.Content.Headers.ContentLength
        $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out    = [System.IO.File]::Create($dest)
        try {
            $buffer = New-Object byte[] 262144   # 256 KB: frequent, smooth updates
            $read   = [long]0
            $lastPct = -1
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while (($n = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $out.Write($buffer, 0, $n)
                $out.Flush()
                $read += $n
                if ($total) {
                    $pct = [math]::Min(100, [int](100 * $read / $total))
                    if ($pct -ne $lastPct) { Write-DownloadBar $read $total $sw.Elapsed.TotalSeconds; $lastPct = $pct }
                } else {
                    Write-DownloadBar $read $total $sw.Elapsed.TotalSeconds
                }
            }
            Write-DownloadBar $read $total $sw.Elapsed.TotalSeconds
            Write-Host ""   # finish the bar line
        } finally { $out.Dispose(); $stream.Dispose() }
    } finally { $client.Dispose() }
}

function Main {
    Say "Resolving the latest release of $Repo ..."

    # Windows PowerShell 5.1 can default to TLS 1.0/1.1; GitHub needs TLS 1.2+.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $headers = @{ "User-Agent" = $UserAgent }
    # A refused connection on the first try is usually a momentary network
    # blip - retry calmly before giving up (GitHub had one of those today).
    $release = $null
    foreach ($try in 1..3) {
        try {
            $release = Invoke-RestMethod -Uri $Api -Headers $headers -ErrorAction Stop
            break
        } catch {
            if ($try -ge 3) { throw "Could not reach GitHub: $(Clean-Err $_)" }
            Warn "Could not reach GitHub (try $try of 3) - retrying ..."
            Start-Sleep -Seconds (2 * $try)
        }
    }

    # Prefer the NSIS Setup: it installs properly (Start Menu entry +
    # uninstaller). The portable exe is only a fallback for odd cases.
    $asset = $release.assets |
        Where-Object { $_.name -match "Setup-.*x64\.exe$" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $release.assets |
            Where-Object { $_.name -match "portable\.exe$" -and $_.name -match "x64" } |
            Select-Object -First 1
    }
    if (-not $asset) {
        $asset = $release.assets | Where-Object { $_.name -match "portable\.exe$" } | Select-Object -First 1
    }
    if (-not $asset) {
        throw "No Windows build in the latest release ($($release.tag_name)). Install manually from $ReleasePage"
    }

    $Version = $release.tag_name
    Say "Found $($asset.name) ($Version)"

    # --- Download (with one automatic retry) --------------------------------
    $tmp = Join-Path $env:TEMP $asset.name
    $sizeMb = [math]::Round($asset.size / 1MB, 1)
    Say "Downloading $($asset.name) ($sizeMb MB) ..."
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Download-WithProgress -url $asset.browser_download_url -dest $tmp
            break
        } catch {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Write-Host ""
            if ($attempt -ge 2) { throw "Download failed: $(Clean-Err $_)" }
            Warn "Network hiccup - retrying (try $($attempt + 1) of 2) ..."
            Start-Sleep -Seconds 2
        }
    }

    # Sanity check: an error page, or a file quarantined by antivirus, is not
    # a ~100 MB exe.
    if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 50MB) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw "The downloaded file is missing or too small - your antivirus may have quarantined it. Whitelist the app, or download it manually from $ReleasePage"
    }

    # --- Install -------------------------------------------------------------
    if ($asset.name -match "Setup-") {
        Say "Installing silently (Start Menu entry + uninstaller included) ..."
        # NSIS: /S = silent. /D= overrides the directory; it must be the LAST
        # argument and is parsed to the end of the command line, so pass the
        # whole argument list as one string (PowerShell would otherwise quote
        # the space-containing path and break the flag).
        $setupArgs = "/S"
        if ($env:KCD_INSTALL_DIR) { $setupArgs = "/S /D=$($env:KCD_INSTALL_DIR.TrimEnd('\'))" }
        $proc = Start-Process -FilePath $tmp -ArgumentList $setupArgs -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            throw "The installer exited with code $($proc.ExitCode). Is Kimi Code Desktop still running? Close it and retry."
        }
        # A previous script version installed a bare portable exe under a
        # slightly different name - clean it up so only the real install stays.
        Remove-Item (Join-Path $LegacyDir "Kimi-Code-Desktop.exe") -Force -ErrorAction SilentlyContinue
        Remove-Item $LegacyDir -Force -ErrorAction SilentlyContinue
    } else {
        New-Item -ItemType Directory -Force -Path $LegacyDir | Out-Null
        Move-Item -Force $tmp (Join-Path $LegacyDir $ExeName)
    }

    if (Test-Path $ExePath) { Ok "Installed: $ExePath" }
    else { throw "Setup finished but $ExePath is missing - look in $InstallDir" }

    Ensure-KimiCli
    Write-Host ""
    Ok "Kimi Code Desktop was installed successfully."
    Info "Search the Start Menu for 'Kimi Code Desktop', or run: $ExePath"
    Info "Uninstall any time via 'Add or Remove Programs' (or the Uninstall exe in the app folder)."
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
}
