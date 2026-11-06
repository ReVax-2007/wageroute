# WageRoute installer for Windows (Windows PowerShell 5.1 or PowerShell 7).
#
#   irm https://revax-2007.github.io/wageroute/install.ps1 | iex
#
# Options, when piped (environment variables):
#   $env:WAGEROUTE_VERSION = 'v1.3.1'   install this release instead of the latest
#   $env:WAGEROUTE_DRY_RUN = '1'        download and verify, install nothing
# Options, when run as a file:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Version v1.3.1 -DryRun
#
# It downloads WageRoute.Setup.<version>.exe from
# https://github.com/ReVax-2007/wageroute/releases, checks it against that
# release's SHA256SUMS, removes the "downloaded from the internet" mark so
# SmartScreen does not stop it, and installs it silently for the current user
# (Start menu entry, uninstall from Settings > Apps).
#
# It never reads, moves or deletes your ledger, which WageRoute keeps in
# %APPDATA%\WageRoute.

param(
  [string]$Version = $env:WAGEROUTE_VERSION,
  [switch]$DryRun
)

function Install-WageRoute {
  param([string]$Tag, [bool]$DryRun)

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $releases = 'https://github.com/ReVax-2007/wageroute/releases'

  $onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
  if (-not $onWindows) {
    throw 'install.ps1 is for Windows. On macOS or Linux use: curl -fsSL https://revax-2007.github.io/wageroute/install.sh | sh'
  }

  if (-not $Tag) {
    try {
      $latest = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 `
        -Uri 'https://api.github.com/repos/ReVax-2007/wageroute/releases/latest' `
        -Headers @{ 'User-Agent' = 'wageroute-install'; 'Accept' = 'application/vnd.github+json' }
      $Tag = [string]$latest.tag_name
    } catch {
      $Tag = $null
    }
    if ($Tag -notmatch '^v[0-9]') {
      # The API is rate-limited per address; the releases page is not. Follow
      # its redirect to /tag/<version> instead.
      $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$releases/latest"
      $final = if ($page.BaseResponse.ResponseUri) { $page.BaseResponse.ResponseUri.AbsoluteUri } else { $page.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
      if ($final -notmatch '/tag/(v[0-9][^/]*)$') { throw "Could not read the latest release tag from '$final'." }
      $Tag = $Matches[1]
    }
  }
  if ($Tag -notmatch '^v') { $Tag = "v$Tag" }
  $version = $Tag.Substring(1)

  Write-Host "WageRoute $version"
  $asset = "WageRoute.Setup.$version.exe"
  $base = "$releases/download/$Tag"
  $work = Join-Path ([IO.Path]::GetTempPath()) ("wageroute-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null

  try {
    $exe = Join-Path $work $asset
    $sums = Join-Path $work 'SHA256SUMS'
    Write-Host "==> Downloading $asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0].ToLowerInvariant(); break }
    }
    if (-not $expected) { throw "$asset is not listed in the release's SHA256SUMS." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed." }
    Write-Host "Checksum OK ($actual)"

    if ($DryRun) { Write-Host "Dry run: $asset verified, nothing installed."; return }

    if (Get-Process -Name 'WageRoute' -ErrorAction SilentlyContinue) {
      throw 'WageRoute is running. Close it and run this again.'
    }

    # A download made by PowerShell carries no Mark of the Web, but clear it
    # anyway so SmartScreen has nothing to stop.
    Unblock-File -LiteralPath $exe

    Write-Host '==> Installing for the current user'
    $process = Start-Process -FilePath $exe -ArgumentList '/S', '/currentuser' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "The installer exited with code $($process.ExitCode)." }

    $installed = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\WageRoute\WageRoute.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\wageroute\WageRoute.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($installed) {
      Unblock-File -LiteralPath $installed -ErrorAction SilentlyContinue
      Write-Host "Installed $installed"
    } else {
      Write-Host 'Installed.'
    }
    Write-Host 'Open WageRoute from the Start menu. Uninstall it from Settings > Apps.'
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-WageRoute -Tag $Version -DryRun ($DryRun.IsPresent -or $env:WAGEROUTE_DRY_RUN -eq '1')
