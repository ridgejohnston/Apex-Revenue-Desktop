; ════════════════════════════════════════════════════════════════════════════
; APEX REVENUE DESKTOP — Thin Installer v1.0.0
; Installs Electron runtime, then downloads app.asar from AWS S3.
; app.asar is never bundled — the installer always pulls the latest version.
; ════════════════════════════════════════════════════════════════════════════

Unicode True
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; ── Metadata ──────────────────────────────────────────────────────────────────
!define PRODUCT_NAME        "Apex Revenue"
!define PRODUCT_VERSION     "1.0.0"
!define PRODUCT_PUBLISHER   "Ridge Johnston"
!define PRODUCT_URL         "https://apexrevenue.works"
!define PRODUCT_EXE         "Apex Revenue.exe"
!define PRODUCT_UNINST_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\ApexRevenue"
!define PRODUCT_DIR_REGKEY  "Software\ApexRevenue"
!define INSTALL_DIR         "$PROGRAMFILES64\Apex Revenue"

; S3 source for app.asar (always the latest deployed version)
!define APP_ASAR_URL  "https://apex-revenue-app-994438967527.s3.amazonaws.com/app.asar"

Name                  "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile               "ApexRevenue-Setup-1.0.0.exe"
InstallDir            "${INSTALL_DIR}"
InstallDirRegKey      HKLM "${PRODUCT_DIR_REGKEY}" "InstallDir"
RequestExecutionLevel admin
BrandingText          "Apex Revenue — Creator Intelligence Engine"

; ── Modern UI ─────────────────────────────────────────────────────────────────
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON              "..\assets\icons\icon.ico"
!define MUI_UNICON            "..\assets\icons\icon.ico"

!define MUI_WELCOMEPAGE_TITLE     "Welcome to Apex Revenue Desktop"
!define MUI_WELCOMEPAGE_TEXT      "AWS-Powered Creator Intelligence Engine.$\r$\n$\r$\nThis installer will:$\r$\n$\r$\n  1. Install the Apex Revenue runtime$\r$\n  2. Download the latest app from AWS S3$\r$\n$\r$\nAn internet connection is required.$\r$\n$\r$\nThe app updates automatically — no reinstalling needed."

!define MUI_FINISHPAGE_TITLE      "Apex Revenue Installed"
!define MUI_FINISHPAGE_TEXT       "Installation complete.$\r$\n$\r$\nThe app will auto-update whenever a new version is deployed to AWS."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT   "Launch Apex Revenue"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_LINK       "apexrevenue.works"
!define MUI_FINISHPAGE_LINK_LOCATION "https://apexrevenue.works"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ════════════════════════════════════════════════════════════════════════════
; INSTALL
; ════════════════════════════════════════════════════════════════════════════

Section "Apex Revenue (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; ── Electron runtime (static — only changes when Electron version bumps) ──
  DetailPrint "Installing Apex Revenue runtime…"

  File "..\dist\win-unpacked\Apex Revenue.exe"
  File "..\dist\win-unpacked\LICENSE.electron.txt"
  File "..\dist\win-unpacked\LICENSES.chromium.html"
  File "..\dist\win-unpacked\chrome_100_percent.pak"
  File "..\dist\win-unpacked\chrome_200_percent.pak"
  File "..\dist\win-unpacked\d3dcompiler_47.dll"
  File "..\dist\win-unpacked\ffmpeg.dll"
  File "..\dist\win-unpacked\icudtl.dat"
  File "..\dist\win-unpacked\libEGL.dll"
  File "..\dist\win-unpacked\libGLESv2.dll"
  File "..\dist\win-unpacked\resources.pak"
  File "..\dist\win-unpacked\snapshot_blob.bin"
  File "..\dist\win-unpacked\v8_context_snapshot.bin"
  File "..\dist\win-unpacked\vk_swiftshader.dll"
  File "..\dist\win-unpacked\vk_swiftshader_icd.json"
  File "..\dist\win-unpacked\vulkan-1.dll"

  SetOutPath "$INSTDIR\locales"
  File /r "..\dist\win-unpacked\locales\*.*"

  ; Create resources directory
  CreateDirectory "$INSTDIR\resources"

  ; ── Download app.asar from AWS S3 (always the latest deployed version) ────
  DetailPrint "Connecting to AWS S3…"
  DetailPrint "Downloading latest app from AWS S3 (this may take a moment)…"

  ; Try NSISdl first (built-in, no extra plugin needed)
  NSISdl::download /TIMEOUT=30000 "${APP_ASAR_URL}" "$INSTDIR\resources\app.asar"
  Pop $R0

  ${If} $R0 != "success"
    ; NSISdl failed — try PowerShell fallback
    DetailPrint "NSISdl failed ($R0) — trying PowerShell download…"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command \
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; \
       $ProgressPreference=''SilentlyContinue''; \
       Invoke-WebRequest -Uri ''${APP_ASAR_URL}'' \
         -OutFile ''$INSTDIR\resources\app.asar'' \
         -UseBasicParsing"'
    Pop $R1

    ; Check if the file was downloaded
    ${IfNot} ${FileExists} "$INSTDIR\resources\app.asar"
      MessageBox MB_ICONEXCLAMATION|MB_OK \
        "Could not download the app from AWS S3.$\r$\n$\r$\n\
         Please check your internet connection and try again.$\r$\n$\r$\n\
         Error: $R0 / PowerShell: $R1"
      Abort
    ${EndIf}
  ${EndIf}

  ; Verify app.asar was downloaded and has content
  ${IfNot} ${FileExists} "$INSTDIR\resources\app.asar"
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "App download failed — app.asar not found after download.$\r$\n\
       Check internet connection and retry."
    Abort
  ${EndIf}

  DetailPrint "App downloaded from AWS S3 successfully."

  ; ── Registry ──────────────────────────────────────────────────────────────
  WriteRegStr   HKLM "${PRODUCT_DIR_REGKEY}" "InstallDir"  "$INSTDIR"
  WriteRegStr   HKLM "${PRODUCT_DIR_REGKEY}" "Version"     "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "URLInfoAbout"    "${PRODUCT_URL}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "EstimatedSize" "$0"

  ; ── Uninstaller ───────────────────────────────────────────────────────────
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; ── Desktop shortcut ──────────────────────────────────────────────────────
  CreateShortcut "$DESKTOP\Apex Revenue.lnk" \
    "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0 \
    SW_SHOWNORMAL "" "Apex Revenue — Creator Intelligence Engine"

  ; ── Start Menu ────────────────────────────────────────────────────────────
  CreateDirectory "$SMPROGRAMS\Apex Revenue"
  CreateShortcut "$SMPROGRAMS\Apex Revenue\Apex Revenue.lnk" \
    "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Apex Revenue\Uninstall.lnk" \
    "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0

SectionEnd

; ════════════════════════════════════════════════════════════════════════════
Function LaunchApp
  ExecShell "" "$INSTDIR\${PRODUCT_EXE}"
FunctionEnd

; ════════════════════════════════════════════════════════════════════════════
; UNINSTALL
; ════════════════════════════════════════════════════════════════════════════

Section "Uninstall"
  ExecWait 'taskkill /F /IM "Apex Revenue.exe"' $0

  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete   "$INSTDIR\Apex Revenue.exe"
  Delete   "$INSTDIR\LICENSE.electron.txt"
  Delete   "$INSTDIR\LICENSES.chromium.html"
  Delete   "$INSTDIR\chrome_100_percent.pak"
  Delete   "$INSTDIR\chrome_200_percent.pak"
  Delete   "$INSTDIR\d3dcompiler_47.dll"
  Delete   "$INSTDIR\ffmpeg.dll"
  Delete   "$INSTDIR\icudtl.dat"
  Delete   "$INSTDIR\libEGL.dll"
  Delete   "$INSTDIR\libGLESv2.dll"
  Delete   "$INSTDIR\resources.pak"
  Delete   "$INSTDIR\snapshot_blob.bin"
  Delete   "$INSTDIR\v8_context_snapshot.bin"
  Delete   "$INSTDIR\vk_swiftshader.dll"
  Delete   "$INSTDIR\vk_swiftshader_icd.json"
  Delete   "$INSTDIR\vulkan-1.dll"
  Delete   "$INSTDIR\Uninstall.exe"
  RMDir    "$INSTDIR"

  Delete "$DESKTOP\Apex Revenue.lnk"
  Delete "$SMPROGRAMS\Apex Revenue\Apex Revenue.lnk"
  Delete "$SMPROGRAMS\Apex Revenue\Uninstall.lnk"
  RMDir  "$SMPROGRAMS\Apex Revenue"

  DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
SectionEnd
