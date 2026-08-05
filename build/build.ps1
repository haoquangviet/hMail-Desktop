# MIT License — Copyright (c) 2026 HQV Software
# build.ps1 — reproducible build of hMail Desktop from the pinned official
# Mozilla Thunderbird release (see UPSTREAM.md). Windows PowerShell 5.1+.
#
# Usage:
#   .\build\build.ps1                     # full build -> dist\hMailDesktopSetup-<ver>.exe
#   .\build\build.ps1 -SkipInstaller      # stop after producing work\app (for testing)
#
param(
    [string]$Version      = "0.1.1",
    [string]$TbVersion    = "140.13.0esr",
    [string]$Locale       = "vi",
    [string]$Arch         = "win64",
    [switch]$SkipDownload,
    [switch]$SkipInstaller,
    # Authenticode-sign hmail.exe and the installer with the HQV Software
    # code-signing certificate (hardware token must be present).
    [switch]$Sign,
    # "cloud" - hSigntool against the HQV signing service (no local token needed)
    # "local" - hAutoSignerService.exe --codesign against the attached USB token
    [ValidateSet("cloud", "local")]
    [string]$SignVia = "cloud",
    [string]$SignVaultUrl = "https://autosign.hqv.biz",
    [string]$SignVaultToken = $env:HMAIL_SIGN_TOKEN,
    [string]$SignVaultCert = "hqv-codesign",
    [string]$SignThumbprint = $env:HMAIL_SIGN_THUMBPRINT,
    # The USB token's PIN. Never hard-code it here: this repository is public.
    [string]$SignPin = $env:HMAIL_SIGN_PIN
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Work     = Join-Path $RepoRoot "work"
$Dist     = Join-Path $RepoRoot "dist"
$Tools    = Join-Path $RepoRoot "build\tools"
$App      = Join-Path $Work "app"

$SevenZip = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $SevenZip)) { throw "7-Zip not found at $SevenZip - install 7-Zip first." }

New-Item -ItemType Directory -Force -Path $Work, $Dist, $Tools | Out-Null

function Log([string]$msg) { Write-Host "[build] $msg" -ForegroundColor Cyan }

$SignerTool  = "C:\HQVSoftware\Projects\autosignpdf\publish\hAutoSignerService.exe"
$CloudSigner = "C:\HQVSoftware\Projects\autosignpdf\publish\hSigntool.exe"

function Invoke-CodeSign([string]$Path) {
    Log "Signing $(Split-Path -Leaf $Path) via $SignVia"

    # rcedit drops the signature blob but leaves the PE certificate-table
    # pointer addressing bytes past EOF, which makes every signing tool fail
    # with 0x800700C1. Clear the stale pointer first.
    python (Join-Path $PSScriptRoot "fix_pe_certdir.py") $Path | Out-Null

    if ($SignVia -eq "cloud") {
        if (-not (Test-Path $CloudSigner)) { throw "Signer not found: $CloudSigner" }
        if (-not $SignVaultToken) {
            throw "No signing token. Set `$env:HMAIL_SIGN_TOKEN or pass -SignVaultToken."
        }
        & $CloudSigner sign `
            -kvu $SignVaultUrl -kva $SignVaultToken -kvc $SignVaultCert `
            -fd sha384 -tr http://ts.ssl.com -td sha384 `
            $Path
    } else {
        # Local USB-token path: the signer writes to a separate output file.
        if (-not (Test-Path $SignerTool)) { throw "Signer tool not found: $SignerTool" }
        if (-not $SignThumbprint -or -not $SignPin) {
            throw "Local signing needs `$env:HMAIL_SIGN_THUMBPRINT and `$env:HMAIL_SIGN_PIN (or -SignThumbprint/-SignPin)."
        }
        $tmp = "$Path.signed"
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        & $SignerTool --codesign `
            /sha1 $SignThumbprint /pin $SignPin `
            /fd sha384 /tr http://ts.ssl.com /td sha384 `
            /d "HAO QUANG VIET SOFTWARE COMPANY LIMITED" /du https://haoquangviet.com `
            /o $tmp $Path
        if (-not (Test-Path $tmp)) {
            throw "Local token signing failed for $Path. A second smart-card token (FT ePass2003) breaks reader enumeration - unplug it, or use -SignVia cloud."
        }
        Move-Item -Force $tmp $Path
    }

    $sig = Get-AuthenticodeSignature $Path
    if ($sig.Status -ne "Valid") { throw "Signature invalid on ${Path}: $($sig.Status)" }
    Log "  signed OK ($($sig.SignerCertificate.Subject.Split(',')[0]))"
}

# ---------------------------------------------------------------- 1. download
$SetupName = "Thunderbird Setup $TbVersion.exe"
$SetupPath = Join-Path $Work $SetupName
$BaseUrl   = "https://archive.mozilla.org/pub/thunderbird/releases/$TbVersion"
$SetupUrl  = "$BaseUrl/$Arch/$Locale/" + [uri]::EscapeDataString($SetupName)

if (-not $SkipDownload -or -not (Test-Path $SetupPath)) {
    if (-not (Test-Path $SetupPath)) {
        Log "Downloading $SetupUrl"
        Invoke-WebRequest -Uri $SetupUrl -OutFile $SetupPath -UseBasicParsing
    } else {
        Log "Installer already present: $SetupPath"
    }
}

# ------------------------------------------------------ 2. verify SHA-256 pin
Log "Verifying SHA-256 against upstream SHA256SUMS"
$SumsPath = Join-Path $Work "SHA256SUMS-$TbVersion.txt"
if (-not (Test-Path $SumsPath)) {
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $SumsPath -UseBasicParsing
}
$needle = "$Arch/$Locale/$SetupName"
$line = Select-String -Path $SumsPath -SimpleMatch $needle | Select-Object -First 1
if (-not $line) { throw "No SHA256SUMS entry for $needle" }
$expected = ($line.Line -split '\s+')[0].ToLower()
$actual = (Get-FileHash -Algorithm SHA256 -Path $SetupPath).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA-256 mismatch! expected=$expected actual=$actual" }
Log "SHA-256 OK: $actual"
Log "(record this hash in UPSTREAM.md if not yet pinned)"

# ---------------------------------------------------------------- 3. extract
$Extracted = Join-Path $Work "extracted"
if (Test-Path $Extracted) { Remove-Item -Recurse -Force $Extracted }
Log "Extracting installer"
& $SevenZip x -y "-o$Extracted" $SetupPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7z extraction failed" }
$CoreSrc = Join-Path $Extracted "core"
if (-not (Test-Path $CoreSrc)) { throw "No core\ directory in extracted installer" }

if (Test-Path $App) { Remove-Item -Recurse -Force $App }
Copy-Item -Recurse $CoreSrc $App
Log "Fresh app dir at $App"

# ----------------------------------------- 4. rebrand omni.ja + VisualElements
Log "Patching omni.ja / BuildID / VisualElements (omni_tool.py)"
python (Join-Path $PSScriptRoot "omni_tool.py") --core $App --repo $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "omni_tool.py failed" }

# ------------------------------------------------- 5. kill Mozilla update path
Log "Removing Mozilla updater / maintenance service files"
$killList = @("updater.exe", "updater.ini", "update-settings.ini", "precomplete",
              "removed-files", "maintenanceservice.exe", "maintenanceservice_installer.exe",
              "default-browser-agent.exe", "pingsender.exe", "crashreporter.exe",
              "crashreporter.ini", "minidump-analyzer.exe")
foreach ($f in $killList) {
    $p = Join-Path $App $f
    if (Test-Path $p) { Remove-Item -Force $p; Log "  removed $f" }
}

# --------------------------------------------------------- 6. exe rename + PE
$ThunderbirdExe = Join-Path $App "thunderbird.exe"
$HmailExe       = Join-Path $App "hmail.exe"
if (Test-Path $ThunderbirdExe) { Rename-Item $ThunderbirdExe "hmail.exe" }

$Rcedit = Join-Path $Tools "rcedit-x64.exe"
if (-not (Test-Path $Rcedit)) {
    Log "Downloading rcedit"
    Invoke-WebRequest -Uri "https://github.com/electron/rcedit/releases/latest/download/rcedit-x64.exe" `
        -OutFile $Rcedit -UseBasicParsing
}
$Ico = Join-Path $RepoRoot "branding\hmail.ico"
Log "Rewriting PE resources on hmail.exe"
& $Rcedit $HmailExe `
    --set-icon $Ico `
    --set-version-string "CompanyName" "HQV Software" `
    --set-version-string "ProductName" "hMail Desktop" `
    --set-version-string "FileDescription" "hMail Desktop" `
    --set-version-string "InternalName" "hMail Desktop" `
    --set-version-string "OriginalFilename" "hmail.exe" `
    --set-version-string "LegalCopyright" "(c) HQV Software. Based on Mozilla Thunderbird (MPL 2.0)." `
    --set-file-version "$Version.0" `
    --set-product-version "$Version.0"
if ($LASTEXITCODE -ne 0) { throw "rcedit failed on hmail.exe" }

$PluginContainer = Join-Path $App "plugin-container.exe"
if (Test-Path $PluginContainer) {
    & $Rcedit $PluginContainer --set-version-string "FileDescription" "hMail Desktop helper"
}

# rcedit invalidates Mozilla's Authenticode signature, so re-sign our binaries.
if ($Sign) {
    Invoke-CodeSign $HmailExe
    if (Test-Path $PluginContainer) { Invoke-CodeSign $PluginContainer }
}

# --------------------------------------------------------- 7. window icons
Log "Replacing window icons (chrome\icons\default)"
$IconDir = Join-Path $App "chrome\icons\default"
if (Test-Path $IconDir) {
    foreach ($icoFile in Get-ChildItem $IconDir -Filter *.ico) {
        Copy-Item $Ico $icoFile.FullName -Force
    }
}

# --------------------------------------------------------------- 8. overlay
Log "Applying overlay (distribution, autoconfig, hmail-chrome)"
Copy-Item -Recurse -Force (Join-Path $RepoRoot "overlay\*") $App

# The start page ships inside the application so the message pane still has
# something to show with no network. docs/ is the single source: the same
# files serve the public site on GitHub Pages.
Log "Bundling the start page"
$StartDir = Join-Path $App "hmail-start"
New-Item -ItemType Directory -Force -Path (Join-Path $StartDir "assets") | Out-Null
Copy-Item (Join-Path $RepoRoot "docs\start.html") $StartDir -Force
foreach ($asset in @("brand.css", "i18n.js", "hMail.svg")) {
    Copy-Item (Join-Path $RepoRoot "docs\assets\$asset") `
              (Join-Path $StartDir "assets") -Force
}

# The AI assistant is no longer an add-on. It was a repack of a third-party
# extension whose chat lived in popup windows and whose "which message is this
# about?" state was held by a background script keyed to its own toolbar
# button — a docked panel could never be handed the current message, so prompts
# quoting the mail always ran on empty content. It is now privileged chrome in
# overlay/hmail-ribbon/aiassistant*.js, shipped with the rest of the overlay.

# --------------------------------------------------- tray helper (Windows)
# The platform's own tray icon is created in C++ and carries no menu, so a
# right-click does nothing. This is hMail's own icon: a few kilobytes with
# Open / Compose / Quit, each item handed back to the application as an
# hmail:// link. Built with the csc that ships with Windows, so the installer
# carries no runtime of its own.
$Csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $Csc) {
    Log "Building the tray helper"
    $TrayExe = Join-Path $App "hmailtray.exe"
    & $Csc /nologo /target:winexe /optimize+ /out:"$TrayExe" `
        /reference:System.dll /reference:System.Drawing.dll `
        /reference:System.Windows.Forms.dll `
        (Join-Path $RepoRoot "installer\tray\hMailTray.cs")
    if ($LASTEXITCODE -ne 0) { throw "tray helper build failed" }
    if ($Sign) { Invoke-CodeSign $TrayExe }
} else {
    Log "WARNING: csc.exe not found - shipping without the tray helper"
}

# version pref consumed by the hMail update channel in hmail.cfg
Set-Content -Encoding ASCII -Path (Join-Path $App "defaults\pref\hmail.js") `
    -Value "pref(""hmail.version"", ""$Version"");"

# .purgecaches: one-shot startup cache purge on first launch
New-Item -ItemType File -Force -Path (Join-Path $App ".purgecaches") | Out-Null

Log "App directory ready: $App"

# --------------------------------------------------------------- 9. installer
if ($SkipInstaller) { Log "SkipInstaller set - done."; exit 0 }

$Makensis = @((Join-Path $Tools "nsis-3.12\makensis.exe"),
              "C:\Program Files (x86)\NSIS\makensis.exe", "C:\Program Files\NSIS\makensis.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Makensis) {
    $cmd = Get-Command makensis -ErrorAction SilentlyContinue
    if ($cmd) { $Makensis = $cmd.Source }
}
if (-not $Makensis) {
    Log "WARNING: NSIS (makensis) not found - skipping installer. Install NSIS and re-run."
    exit 0
}
Log "Building installer with NSIS"
# /INPUTCHARSET UTF8: the script holds Vietnamese UI strings; without this
# makensis reads it in the system ANSI codepage and they render as mojibake.
& $Makensis "/INPUTCHARSET" "UTF8" "/DVERSION=$Version" "/DAPPDIR=$App" `
    "/DOUTDIR=$Dist" (Join-Path $RepoRoot "installer\hmail.nsi")
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }
$InstallerPath = Join-Path $Dist "hMailDesktopSetup-$Version.exe"
if ($Sign) { Invoke-CodeSign $InstallerPath }
Log "Installer: $InstallerPath"
