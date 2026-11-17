# GPTWorkRouter installer for Windows. Run in PowerShell (not as administrator):
#   irm @INSTALL_URL@/install.ps1 | iex
# Downloads this version once into ~\.gptworkrouter\app\<version>, checks it, then starts
# the setup wizard. Running it again opens the wizard's menu (repair, update, uninstall).
# Runs through iex, so it never calls exit (that would close the user's window) and never
# uses npm (blocked by the default ExecutionPolicy on a fresh Windows).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar on
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Version = '@VERSION@'
  # This version's archives. GWR_BASE_URL: a test host laid out as <base>/releases/<version>/.
  $Files = if ($env:GWR_BASE_URL) { "$env:GWR_BASE_URL/releases/$Version" } else { '@FILES_URL@' }
  $Data = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME '.gptworkrouter' }
  $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($Arch) {
    'ARM64' { $Plat = 'win32-arm64'; $Sum = '@SHA_win32-arm64@' }
    'AMD64' { $Plat = 'win32-x64'; $Sum = '@SHA_win32-x64@' }
    default { Write-Host "This computer's processor ($Arch) is not supported." -ForegroundColor Red; return }
  }

  $App = Join-Path (Join-Path $Data 'app') $Version
  $Node = Join-Path $App 'node\node.exe'
  if (-not (Test-Path -LiteralPath $Node)) {
    $File = "gptworkrouter-$Version-$Plat.tar.gz"
    $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("gwr-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Force (Join-Path $Tmp 'x') | Out-Null
    try {
      Write-Host "Downloading GPTWorkRouter $Version (about 300 MB)..."
      try { Invoke-WebRequest -UseBasicParsing -Uri "$Files/$File" -OutFile (Join-Path $Tmp $File) }
      catch { Write-Host 'The download failed. Check your internet connection and run the command again.' -ForegroundColor Red; return }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Tmp $File)).Hash -ne $Sum) {
        Write-Host 'The download is damaged (checksum mismatch), so nothing was installed. Run the command again.' -ForegroundColor Red; return
      }
      # tar.exe is built into Windows 10+ and much faster than Expand-Archive for many small files.
      & "$env:SystemRoot\System32\tar.exe" -xzf (Join-Path $Tmp $File) -C (Join-Path $Tmp 'x')
      if ($LASTEXITCODE -ne 0) { Write-Host 'Unpacking failed. Run the command again.' -ForegroundColor Red; return }
      New-Item -ItemType Directory -Force (Join-Path $Data 'app') | Out-Null
      if (Test-Path -LiteralPath $App) { Remove-Item -LiteralPath $App -Recurse -Force }
      Move-Item -LiteralPath (Join-Path $Tmp 'x') -Destination $App
    }
    finally { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }

  & $Node (Join-Path $App 'installer\setup.mjs') @args
  # 3 = uninstalled: remove the app folders now that Node has exited (Windows locks running files).
  if ($LASTEXITCODE -eq 3) {
    Remove-Item -LiteralPath (Join-Path $Data 'app') -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Get-ChildItem -LiteralPath $Data -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $Data -Force -ErrorAction SilentlyContinue }
  }
} @args
