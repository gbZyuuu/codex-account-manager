# codex-account-manager one-line installer.
#
#   irm https://raw.githubusercontent.com/gbZyuuu/codex-account-manager/main/install.ps1 | iex
#
# Whoever runs this does NOT need to clone anything and does not need to be in any
# particular folder: the script downloads the project into
# `%LOCALAPPDATA%\codex-account-manager\source` and works from there.
#
# It resolves both dependencies on its own when they are missing:
#   Node.js  -> winget, and if winget does not exist it downloads the official
#               PORTABLE build and uses it only for this project (does not touch
#               the PATH, does not ask for admin)
#   Codex    -> winget through the Microsoft Store
#
# There is NO `npm install` and no build step: the project uses only Node built-in
# modules, and that is why a single line is enough.

$ErrorActionPreference = "Stop"

# ============================== Language =====================================
#
# THE DEFAULT IS ENGLISH, always, regardless of the Windows language. Detecting
# the system language was rejected on purpose: on a Portuguese Windows the default
# would become Portuguese, and "the default is English" would stop being true
# exactly there.
#
# The question comes BEFORE any check, so the first thing the person reads is
# already in their language. Three paths, in this order:
#   1. CAM_LANG set -> honor it and do not ask (useful for automation);
#   2. interactive console -> ask;
#   3. no interactive console -> English, without hanging on an answer that never
#      arrives. A `Read-Host` in a non-interactive context stalls the installer.
if ("$env:CAM_LANG" -ne "") {
  $Lang = if ("$env:CAM_LANG".ToLower().StartsWith("pt")) { "pt" } else { "en" }
} elseif ([Environment]::UserInteractive) {
  Write-Host ""
  Write-Host "  Choose your language  /  Escolha seu idioma"
  Write-Host "    [1] English"
  Write-Host "    [2] Portugues do Brasil"
  $answer = ""
  try {
    $answer = Read-Host "  1 / 2"
  } catch {
    # Host with no read support: fall back to the default instead of breaking.
    $answer = ""
  }
  $Lang = if ("$answer".Trim() -eq "2") { "pt" } else { "en" }
} else {
  $Lang = "en"
}
# Propagate to child processes: without this PowerShell would speak Portuguese
# while Node stayed in English within the same run.
$env:CAM_LANG = $Lang

$MSG = @{
  en = @{
    winonly     = "This version is Windows-only."
    node_check  = "Checking Node.js"
    node_have   = "already installed: {0} ({1})"
    node_none   = "not found; installing it"
    node_wgfail = "winget could not do it; trying the portable build"
    node_dl     = "Downloading portable Node.js from nodejs.org"
    node_at     = "installed at {0} (does not touch the system PATH)"
    node_ready  = "ready: {0} ({1})"
    node_fail   = "Could not install Node.js. Install it from https://nodejs.org and run again."
    node_nover  = "Could not determine the Node LTS version from nodejs.org."
    node_noexe  = "The Node package came without node.exe."
    codex_check = "Checking Codex"
    codex_have  = "already installed: {0}"
    codex_none  = "not found; installing from the Microsoft Store"
    codex_wgerr = "winget failed"
    codex_page  = "opening the official download page"
    codex_fail  = "Install Codex, open it once to sign in, then run this command again.`nThe official page was opened in your browser."
    disk_check  = "Checking free disk space"
    disk_free   = "free: {0:N1} GB (the copy of Codex uses about 1.8 GB)"
    disk_fail   = "Not enough space. Free up until you have at least 2.5 GB available."
    dl          = "Downloading codex-account-manager"
    dl_fail     = "Download failed. Check the repo, the branch and your connection."
    dl_unzip    = "Could not unpack the download."
    dl_at       = "code at {0}"
    pre         = "Checking the environment (nothing is modified in this step)"
    inst        = "Installing"
    inst_fail   = "Installation failed. The message above says why; the original Codex was not changed."
    watch       = "Turning on the Codex update watcher"
    watch_fail  = "could not turn the watcher on; the panel works, but run this later:"
    done        = "Done. Open Codex through one of these:"
    done_desk   = "  - the 'Codex Account Manager' shortcut on your Desktop"
    done_menu   = "  - the same shortcut in the Start Menu"
    done_why    = "The Desktop shortcut exists because the Windows Start Menu index`nsometimes does not list a freshly created shortcut. The Desktop does not`nuse an index, so it shows up immediately."
    others      = "Other commands:"
    c_doctor    = "state and versions"
    c_pre       = "read-only"
    c_watch     = "active triggers"
    c_uninst    = "back to the original Codex"
    lang_hint   = "Language: English by default. Set CAM_LANG=pt for Portuguese."
  }
  pt = @{
    winonly     = "Esta versao e somente para Windows."
    node_check  = "Verificando o Node.js"
    node_have   = "ja instalado: {0} ({1})"
    node_none   = "nao encontrado; vou instalar"
    node_wgfail = "winget nao conseguiu; tentando a build portatil"
    node_dl     = "Baixando o Node.js portatil da nodejs.org"
    node_at     = "instalado em {0} (nao mexe no PATH do sistema)"
    node_ready  = "pronto: {0} ({1})"
    node_fail   = "Nao consegui instalar o Node.js. Instale de https://nodejs.org e rode de novo."
    node_nover  = "Nao consegui descobrir a versao LTS do Node em nodejs.org."
    node_noexe  = "O pacote do Node veio sem node.exe."
    codex_check = "Verificando o Codex"
    codex_have  = "ja instalado: {0}"
    codex_none  = "nao encontrado; vou instalar pela Microsoft Store"
    codex_wgerr = "winget falhou"
    codex_page  = "abrindo a pagina oficial de download"
    codex_fail  = "Instale o Codex, abra ele uma vez para fazer login, e rode este comando de novo.`nA pagina oficial foi aberta no navegador."
    disk_check  = "Verificando espaco em disco"
    disk_free   = "livre: {0:N1} GB (a copia do Codex usa cerca de 1,8 GB)"
    disk_fail   = "Espaco insuficiente. Libere ate ter pelo menos 2,5 GB livres."
    dl          = "Baixando o codex-account-manager"
    dl_fail     = "Download falhou. Confira o repo, a branch e a conexao."
    dl_unzip    = "Nao consegui descompactar o download."
    dl_at       = "codigo em {0}"
    pre         = "Conferindo o ambiente (nada e modificado nesta etapa)"
    inst        = "Instalando"
    inst_fail   = "A instalacao falhou. A mensagem acima diz o motivo; o Codex original nao foi alterado."
    watch       = "Ligando o vigia de atualizacao do Codex"
    watch_fail  = "nao consegui ligar o vigia; o painel funciona, mas rode isto depois:"
    done        = "Pronto. Abra o Codex por um destes:"
    done_desk   = "  - o atalho 'Codex Account Manager' na Area de Trabalho"
    done_menu   = "  - o mesmo atalho no Menu Iniciar"
    done_why    = "O atalho da Area de Trabalho existe porque o indice do Menu Iniciar do`nWindows as vezes nao lista um atalho recem-criado. A Area de Trabalho nao`nusa indice, entao aparece na hora."
    others      = "Outros comandos:"
    c_doctor    = "estado e versoes"
    c_pre       = "so leitura"
    c_watch     = "gatilhos ativos"
    c_uninst    = "volta ao Codex original"
    lang_hint   = "Idioma: ingles por padrao. Defina CAM_LANG=en para voltar ao ingles."
  }
}

function T($Key) { $MSG[$Lang][$Key] }

$Repo = if ($env:CODEX_ACCOUNT_MANAGER_REPO) { $env:CODEX_ACCOUNT_MANAGER_REPO } else { "gbZyuuu/codex-account-manager" }
$Ref = if ($env:CODEX_ACCOUNT_MANAGER_REF) { $env:CODEX_ACCOUNT_MANAGER_REF } else { "main" }
$Root = Join-Path $env:LOCALAPPDATA "codex-account-manager"
$InstallDir = if ($env:CODEX_ACCOUNT_MANAGER_SOURCE_DIR) { $env:CODEX_ACCOUNT_MANAGER_SOURCE_DIR } else { Join-Path $Root "source" }
$NodeDir = Join-Path $Root "node"

function Fail($Message) {
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("[!] $Message")
  exit 1
}
function Step($Message) { Write-Host "" ; Write-Host "==> $Message" }
function Have($Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

if ($env:OS -ne "Windows_NT") { Fail (T "winonly") }

# ============================== Node.js ======================================
#
# After a `winget install`, the PATH of the CURRENT SESSION is not refreshed. That
# is why we never trust `Get-Command node` after installing: we look for node.exe
# on disk and use the absolute path for the rest of the script.
function Find-NodeExe {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += Join-Path $NodeDir "node.exe"
  $candidates += "$env:ProgramFiles\nodejs\node.exe"
  $candidates += "${env:ProgramFiles(x86)}\nodejs\node.exe"
  $candidates += Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) {
      try {
        $major = [int](& $c -p "Number(process.versions.node.split('.')[0])" 2>$null)
        if ($major -ge 18) { return $c }
      } catch { }
    }
  }
  return $null
}

function Install-NodePortable {
  # Official .zip build, no installer and no admin. The version comes from the
  # official index: we take the latest LTS, so no number is pinned and left to age.
  Step (T "node_dl")
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
  $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
  if (-not $lts) { Fail (T "node_nover") }
  $ver = $lts.version
  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  $name = "node-$ver-win-$arch"
  $url = "https://nodejs.org/dist/$ver/$name.zip"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("node." + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Write-Host "    $ver ($arch)"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "node.zip") -UseBasicParsing
    Expand-Archive -Path (Join-Path $tmp "node.zip") -DestinationPath $tmp -Force
    $inner = Join-Path $tmp $name
    if (-not (Test-Path (Join-Path $inner "node.exe"))) { Fail (T "node_noexe") }
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    New-Item -ItemType Directory -Force -Path (Split-Path $NodeDir) | Out-Null
    Move-Item -Path $inner -Destination $NodeDir
    Write-Host ("    " + ((T "node_at") -f $NodeDir))
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Step (T "node_check")
$Node = Find-NodeExe
if ($Node) {
  Write-Host ("    " + ((T "node_have") -f $Node, (& $Node -v)))
} else {
  Write-Host ("    " + (T "node_none"))
  if (Have "winget") {
    try {
      & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    } catch {
      Write-Host ("    " + (T "node_wgfail"))
    }
    $Node = Find-NodeExe
  }
  if (-not $Node) {
    Install-NodePortable
    $Node = Find-NodeExe
  }
  if (-not $Node) { Fail (T "node_fail") }
  Write-Host ("    " + ((T "node_ready") -f $Node, (& $Node -v)))
}

# ============================== Codex ========================================
function Find-Codex {
  $pkg = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) { return $pkg.Version }
  if (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\Codex\ChatGPT.exe")) { return "local" }
  $squirrel = Get-ChildItem (Join-Path $env:LOCALAPPDATA "codex") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "app-*" }
  if ($squirrel) { return "local" }
  return $null
}

Step (T "codex_check")
$CodexVer = Find-Codex
if ($CodexVer) {
  Write-Host ("    " + ((T "codex_have") -f $CodexVer))
} else {
  Write-Host ("    " + (T "codex_none"))
  if (Have "winget") {
    # `-s msstore` is the documented path. It requires accepting the Store terms
    # and may open a Microsoft sign-in window - which is why we do NOT use --silent.
    try {
      & winget install --name Codex --source msstore --accept-source-agreements --accept-package-agreements
    } catch {
      Write-Host ("    " + (T "codex_wgerr"))
    }
    Start-Sleep -Seconds 3
    $CodexVer = Find-Codex
  }
  if (-not $CodexVer) {
    Write-Host ("    " + (T "codex_page"))
    Start-Process "https://developers.openai.com/codex/windows/"
    Fail (T "codex_fail")
  }
  Write-Host ("    " + ((T "codex_have") -f $CodexVer))
}

# ============================== Disk space ===================================
# The copy of the app costs about 1.8 GB. Warning up front beats aborting halfway
# through a robocopy of 5,400 files.
Step (T "disk_check")
$Drive = Get-PSDrive -Name ((Get-Item $env:LOCALAPPDATA).PSDrive.Name)
Write-Host ("    " + ((T "disk_free") -f ($Drive.Free / 1GB)))
if ($Drive.Free -lt 2.5GB) { Fail (T "disk_fail") }

# ============================== Download =====================================
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-account-manager." + [System.Guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  Step (T "dl")
  Write-Host "    https://github.com/$Repo ($Ref)"
  $archive = Join-Path $Work "source.zip"
  try {
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$Ref" -OutFile $archive -UseBasicParsing
  } catch {
    Fail (T "dl_fail")
  }
  Expand-Archive -Path $archive -DestinationPath $Work -Force
  $extracted = Get-ChildItem -Path $Work -Directory | Select-Object -First 1
  if (-not $extracted) { Fail (T "dl_unzip") }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  Move-Item -Path $extracted.FullName -Destination $InstallDir
  Write-Host ("    " + ((T "dl_at") -f $InstallDir))

  # The preflight now prints to the screen on its own. Reading the file here again
  # would show the whole report TWICE in the same run.
  Step (T "pre")
  & $Node (Join-Path $InstallDir "bin\cam.js") preflight

  Step (T "inst")
  & $Node (Join-Path $InstallDir "bin\cam.js") install
  if ($LASTEXITCODE -ne 0) {
    Fail (T "inst_fail")
  }

  # The watcher is part of the one-line install, not an optional extra step.
  # Without it, the first Codex update makes the copy go stale and the panel simply
  # stops showing up - and someone who installed with a single line has no way to
  # connect one thing to the other. Failing here does not take down the install,
  # which has already finished.
  Step (T "watch")
  & $Node (Join-Path $InstallDir "bin\cam.js") watch install
  if ($LASTEXITCODE -ne 0) {
    Write-Host ("    " + (T "watch_fail"))
    Write-Host "      & `"$Node`" `"$InstallDir\bin\cam.js`" watch install"
  }

  Write-Host ""
  Write-Host (T "done")
  Write-Host (T "done_desk")
  Write-Host (T "done_menu")
  Write-Host ""
  Write-Host (T "done_why")
  Write-Host ""
  Write-Host (T "others")
  Write-Host ("  & `"$Node`" `"$InstallDir\bin\cam.js`" doctor        # " + (T "c_doctor"))
  Write-Host ("  & `"$Node`" `"$InstallDir\bin\cam.js`" preflight    # " + (T "c_pre"))
  Write-Host ("  & `"$Node`" `"$InstallDir\bin\cam.js`" watch status  # " + (T "c_watch"))
  Write-Host ("  & `"$Node`" `"$InstallDir\bin\cam.js`" uninstall     # " + (T "c_uninst"))
  Write-Host ""
  Write-Host (T "lang_hint")
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
