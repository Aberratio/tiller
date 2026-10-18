#requires -Version 5.1
<#
Windows bootstrap for tiller: installs what Git Bash needs, then hands over to install.sh inside it.

  .\install.ps1 [-Yes] [install.sh arguments...]      e.g.  .\install.ps1 all      .\install.ps1 --hooks

Installs through winget when missing: Git (with Git Bash), Node LTS, jq, GitHub CLI; Claude Code
through its own installer. Asks before installing unless -Yes. Enables Developer Mode (native
symlinks for `ln -s`) when run as administrator, otherwise says how; without it install.sh falls
back to junctions. Everything after the bootstrap is install.sh, the same script as on macOS and Linux.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$InstallArgs = @()
)
$ErrorActionPreference = 'Stop'
$NodeFloor = [version]'20.11'

function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Node-Ok {
  if (-not (Have node)) { return $false }
  try { return ([version]((node --version) -replace '^v', '')) -ge $NodeFloor } catch { return $false }
}

function Find-Bash {
  foreach ($p in @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
    if (Test-Path $p) { return $p }
  }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $p = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
    if (Test-Path $p) { return $p }
  }
  return $null
}

# --- 1. what is missing ---------------------------------------------------------------------------
$plan = @()   # @{ name; id; cmd }
if (-not (Find-Bash))  { $plan += @{ name = 'git (Git Bash)'; id = 'Git.Git' } }
if (-not (Node-Ok))    { $plan += @{ name = "node >= $NodeFloor"; id = 'OpenJS.NodeJS.LTS' } }
if (-not (Have jq))    { $plan += @{ name = 'jq'; id = 'jqlang.jq' } }
if (-not (Have gh))    { $plan += @{ name = 'gh (optional: PR phases)'; id = 'GitHub.cli' } }
if (-not (Have claude)) { $plan += @{ name = 'claude (optional: lanes)'; cmd = 'irm https://claude.ai/install.ps1 | iex' } }

if ($plan.Count -gt 0) {
  if (($plan | Where-Object { $_.id }) -and -not (Have winget)) {
    Write-Error "winget is missing; install 'App Installer' from the Microsoft Store (or https://aka.ms/getwinget), then rerun."
  }
  Write-Host 'install.ps1: would install, in order:'
  foreach ($p in $plan) {
    $line = if ($p.id) { "winget install --id $($p.id) -e --source winget --accept-package-agreements --accept-source-agreements" } else { $p.cmd }
    Write-Host "  $($p.name): $line"
  }
  if (-not $Yes) {
    $answer = Read-Host 'Run these now? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'install.ps1: nothing run'; exit 4 }
  }
  foreach ($p in $plan) {
    if ($p.id) { winget install --id $p.id -e --source winget --accept-package-agreements --accept-source-agreements }
    else { Invoke-Expression $p.cmd }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Write-Error "install.ps1: failed: $($p.name) (exit $LASTEXITCODE)" }
  }
  Refresh-Path
}

# --- 2. native symlinks (Developer Mode) ----------------------------------------------------------
$devKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$devMode = (Get-ItemProperty -Path $devKey -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
if ($devMode -ne 1) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin) {
    New-Item -Path $devKey -Force | Out-Null
    Set-ItemProperty -Path $devKey -Name AllowDevelopmentWithoutDevLicense -Value 1 -Type DWord
    Write-Host 'install.ps1: Developer Mode enabled (native symlinks)'
  } else {
    Write-Warning 'Developer Mode is off: enable it in Settings > System > For developers for native symlinks, or install.sh falls back to junctions.'
  }
}

# --- 3. hand over to install.sh in Git Bash --------------------------------------------------------
$bash = Find-Bash
if (-not $bash) { Write-Error 'Git Bash not found after installation; open a new terminal and rerun.' }
$root = $PSScriptRoot -replace '\\', '/'
Write-Host "install.ps1: $bash $root/install.sh $($InstallArgs -join ' ')"
& $bash "$root/install.sh" @InstallArgs
$rc = $LASTEXITCODE
if ($rc -eq 0) {
  Write-Host ''
  Write-Host "Set in ~/.claude/settings.json ""env"": ""TILLER_HOME"": ""$root"" and ""CLAUDE_CODE_GIT_BASH_PATH"": ""$($bash -replace '\\', '/')"""
}
exit $rc
