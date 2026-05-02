[CmdletBinding()]
param(
  [ValidateSet('Changed', 'All')]
  [string]$Mode = 'Changed',
  [string]$HostName = '129.80.142.133',
  [string]$SshUser = 'ubuntu',
  [string]$RemotePath = '/home/ubuntu/discord-afk-bot',
  [string]$Pm2Process = 'black-hull-radio',
  [string]$KeyPath = '',
  [switch]$IncludeUntracked,
  [int]$LogLines = 50
)

$ErrorActionPreference = 'Stop'

function Assert-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Resolve-KeyPath {
  param([string]$Provided)

  if ($Provided -and (Test-Path -LiteralPath $Provided)) {
    return (Resolve-Path -LiteralPath $Provided).Path
  }

  $envKey = [Environment]::GetEnvironmentVariable('ORACLE_SSH_KEY_PATH', 'User')
  if ($envKey -and (Test-Path -LiteralPath $envKey)) {
    return (Resolve-Path -LiteralPath $envKey).Path
  }

  $knownPaths = @(
    'C:\Users\DMart\Documents\GitHub\ssh-key-2026-03-29.key'
  )

  foreach ($candidate in $knownPaths) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw @"
No SSH key found.
Provide -KeyPath "C:\path\to\your-key.pem"
or set user environment variable ORACLE_SSH_KEY_PATH.
"@
}

function Get-AllBotFiles {
  param([string]$Root)

  $excludedDirs  = @('node_modules', '.git', 'scripts', '.venv')
  $excludedFiles = @('.env', '.env.local')

  $result = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $rel = $_.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
      $topDir = ($rel -split '/')[0]
      if ($excludedDirs -contains $topDir) { return $false }
      if ($excludedFiles -contains $rel)   { return $false }
      return $true
    } |
    ForEach-Object {
      $_.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
    } |
    Sort-Object

  return $result
}

function Get-ChangedFiles {
  param([switch]$IncludeNew)
  # No git repo — fall back to all files
  return @()
}

function Get-AllTrackedFiles {
  # No git repo — fall back to all files
  return @()
}

function Filter-DeployFiles {
  param([string[]]$Files)

  $excludedPrefixes = @(
    '.git/',
    'node_modules/'
  )

  $excludedNames = @(
    '.env',
    '.env.local'
  )

  $result = foreach ($file in $Files) {
    $normalized = $file -replace '\\', '/'

    if ($excludedNames -contains $normalized) {
      continue
    }

    $skip = $false
    foreach ($prefix in $excludedPrefixes) {
      if ($normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $skip = $true
        break
      }
    }

    if (-not $skip) {
      $normalized
    }
  }

  return $result | Sort-Object -Unique
}

function Ensure-RemoteDirectories {
  param(
    [string]$User,
    [string]$RemoteHost,
    [string]$Key,
    [string]$BasePath,
    [string[]]$RelativeFiles
  )

  $dirs = @($BasePath)

  foreach ($file in $RelativeFiles) {
    $remoteFile = "$BasePath/$file"
    $dir = [System.IO.Path]::GetDirectoryName($remoteFile.Replace('/', '\'))
    if ($dir) {
      $dirs += ($dir -replace '\\', '/')
    }
  }

  $dirs = $dirs | Sort-Object -Unique
  $quotedDirs = $dirs | ForEach-Object { "'$_'" }
  $mkdirCommand = "mkdir -p $($quotedDirs -join ' ')"

  & ssh -i $Key "$User@$RemoteHost" $mkdirCommand
}

function Upload-Files {
  param(
    [string]$User,
    [string]$RemoteHost,
    [string]$Key,
    [string]$BasePath,
    [string]$RepoRoot,
    [string[]]$RelativeFiles
  )

  foreach ($relative in $RelativeFiles) {
    $localPath = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $localPath)) {
      Write-Warning "Skipping missing local path: $relative"
      continue
    }

    $remotePath = "$BasePath/$relative"
    Write-Host "Uploading $relative"
    & scp -i $Key -- "$localPath" "${User}@${RemoteHost}:$remotePath"
  }
}

function Build-NodeCheckCommand {
  param([string[]]$RelativeFiles)

  $checkTargets = @('index.js', 'internal-api.js', 'party-api.js')
  $available = @()

  foreach ($target in $checkTargets) {
    if (Test-Path -LiteralPath $target) {
      $available += $target
    }
  }

  if (-not $available.Count) {
    return ''
  }

  $checks = $available | ForEach-Object { "node --check $_" }
  return ($checks -join ' && ')
}

Assert-CommandExists -Name 'scp'
Assert-CommandExists -Name 'ssh'

$key = Resolve-KeyPath -Provided $KeyPath
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

# Always deploy all bot files — no git required
$files = Get-AllBotFiles -Root $repoRoot

if (-not $files.Count) {
  Write-Host 'No files found in the bot folder. Nothing to deploy.'
  exit 0
}

Write-Host "Deploy mode: $Mode"
Write-Host "Target: ${SshUser}@${HostName}:$RemotePath"
Write-Host "PM2 process: $Pm2Process"
Write-Host "Files to upload: $($files.Count)"

Ensure-RemoteDirectories -User $SshUser -RemoteHost $HostName -Key $key -BasePath $RemotePath -RelativeFiles $files
Upload-Files -User $SshUser -RemoteHost $HostName -Key $key -BasePath $RemotePath -RepoRoot $repoRoot -RelativeFiles $files

$checkCmd = Build-NodeCheckCommand -RelativeFiles $files
if ($checkCmd) {
  $remoteCheck = "cd $RemotePath && $checkCmd"
  Write-Host 'Running remote syntax checks...'
  & ssh -i $key "$SshUser@$HostName" $remoteCheck
}

$restartCommand = "cd $RemotePath && pm2 restart $Pm2Process && pm2 logs $Pm2Process --lines $LogLines"
Write-Host 'Restarting process and tailing logs...'
& ssh -i $key "$SshUser@$HostName" $restartCommand
