param(
  [string]$LatestJsonUrl = "https://raw.githubusercontent.com/contentkueche/subtitle-qa/main/release/latest.json",
  [string]$InstallStateDir = "$env:LOCALAPPDATA\Contentkueche\Subtitle QA",
  [switch]$ForceReinstall
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-UpiaPath {
  $candidates = @(
    "$env:ProgramFiles\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
    "${env:ProgramFiles(x86)}\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
    "$env:CommonProgramFiles\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
    "${env:CommonProgramFiles(x86)}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}) |
    Where-Object { $_ -and (Test-Path $_) }

  foreach ($root in $roots) {
    $found = Get-ChildItem -Path $root -Filter "UnifiedPluginInstallerAgent.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) {
      return $found.FullName
    }
  }

  throw "Adobe UnifiedPluginInstallerAgent.exe was not found. Install/update Adobe Creative Cloud Desktop first."
}

function Invoke-Download {
  param(
    [string]$Uri,
    [string]$OutFile
  )

  $headers = @{}
  if ($env:SUBTITLE_QA_GITHUB_TOKEN) {
    $headers["Authorization"] = "Bearer $env:SUBTITLE_QA_GITHUB_TOKEN"
  }

  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $headers -UseBasicParsing
}

function Get-LatestManifest {
  param([string]$Uri)

  $tempManifest = Join-Path $env:TEMP "subtitle-qa-latest.json"
  Invoke-Download -Uri $Uri -OutFile $tempManifest
  return Get-Content $tempManifest -Raw | ConvertFrom-Json
}

function Get-InstalledVersion {
  param([string]$StateDir)

  $versionFile = Join-Path $StateDir "installed-version.txt"
  if (Test-Path $versionFile) {
    return (Get-Content $versionFile -Raw).Trim()
  }
  return ""
}

function Set-InstalledVersion {
  param(
    [string]$StateDir,
    [string]$Version
  )

  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  Set-Content -Path (Join-Path $StateDir "installed-version.txt") -Value $Version -Encoding UTF8
}

function Test-UpiaPluginInstalled {
  param([string]$UpiaPath)

  try {
    $listOutput = (& $UpiaPath /list all 2>&1 | Out-String)
    return ($listOutput -match "Subtitle QA" -or $listOutput -match "com\.subtitleqa\.panel")
  } catch {
    return $false
  }
}

Write-Step "Reading Subtitle QA release manifest"
$latest = Get-LatestManifest -Uri $LatestJsonUrl

if (-not $latest.version) {
  throw "latest.json is missing 'version'."
}
if (-not $latest.ccxUrl) {
  throw "latest.json is missing 'ccxUrl'."
}

$installedVersion = Get-InstalledVersion -StateDir $InstallStateDir
$installedLabel = "none"
if ($installedVersion -ne "") {
  $installedLabel = $installedVersion
}
Write-Host "Installed version: $installedLabel"
Write-Host "Latest version:    $($latest.version)"

Write-Step "Finding Adobe UPIA installer"
$upia = Get-UpiaPath
Write-Host "UPIA: $upia"

if (($installedVersion -eq $latest.version) -and (-not $ForceReinstall)) {
  if (Test-UpiaPluginInstalled -UpiaPath $upia) {
    Write-Host "Subtitle QA is already up to date and listed by Adobe UPIA." -ForegroundColor Green
    exit 0
  }

  Write-Host "Version marker exists, but Adobe UPIA does not list Subtitle QA. Reinstalling..." -ForegroundColor Yellow
}

Write-Step "Downloading Subtitle QA $($latest.version)"
New-Item -ItemType Directory -Path $InstallStateDir -Force | Out-Null
$fileName = if ($latest.file) { [string]$latest.file } else { "Subtitle-QA-$($latest.version).ccx" }
$ccxPath = Join-Path $InstallStateDir $fileName
Invoke-Download -Uri $latest.ccxUrl -OutFile $ccxPath

if (-not (Test-Path $ccxPath)) {
  throw "Download failed: $ccxPath"
}

if ($latest.sha256) {
  Write-Step "Verifying download"
  $actualHash = (Get-FileHash -Path $ccxPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $expectedHash = ([string]$latest.sha256).ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "Downloaded CCX hash mismatch. Expected $expectedHash, got $actualHash."
  }
}

Write-Step "Installing Subtitle QA $($latest.version)"
& $upia /install $ccxPath
if ($LASTEXITCODE -ne 0) {
  throw "UPIA install failed with exit code $LASTEXITCODE."
}

if (-not (Test-UpiaPluginInstalled -UpiaPath $upia)) {
  throw "UPIA finished, but Subtitle QA is not listed as installed. Run Creative Cloud Desktop once, update Premiere Pro to 25.6+, then rerun with -ForceReinstall."
}

Set-InstalledVersion -StateDir $InstallStateDir -Version $latest.version

Write-Host ""
Write-Host "Subtitle QA $($latest.version) installed successfully." -ForegroundColor Green
Write-Host "Restart Premiere Pro if the panel was open."
