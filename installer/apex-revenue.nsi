; ════════════════════════════════════════════════════════════════════════════
; APEX REVENUE DESKTOP — NSIS Installer Script v1.0.0
; Produces: ApexRevenue-Setup-1.0.0.exe
; Targets:  Windows x64, installs to Program Files
; Features: Desktop shortcut, Start Menu, Uninstaller, App registry entry
; ════════════════════════════════════════════════════════════════════════════

Unicode True

; ── Metadata ──────────────────────────────────────────────────────────────────
!define PRODUCT_NAME        "Apex Revenue"
!define PRODUCT_VERSION     "1.0.0"
!define PRODUCT_PUBLISHER   "Ridge Johnston"
!define PRODUCT_URL         "https://apexrevenue.works"
!define PRODUCT_EXE         "Apex Revenue.exe"
!define PRODUCT_UNINST_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\ApexRevenue"
!define PRODUCT_DIR_REGKEY  "Software\ApexRevenue"
!define INSTALL_DIR         "$PROGRAMFILES64\Apex Revenue"

; ── Compression ───────────────────────────────────────────────────────────────
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; ── General ───────────────────────────────────────────────────────────────────
Name                  "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile               "ApexRevenue-Setup-1.0.0.exe"
InstallDir            "${INSTALL_DIR}"
InstallDirRegKey      HKLM "${PRODUCT_DIR_REGKEY}" "InstallDir"
RequestExecutionLevel admin
ShowInstDetails       show
ShowUnInstDetails     show
BrandingText          "Apex Revenue — Creator Intelligence Engine"

; ── Modern UI ─────────────────────────────────────────────────────────────────
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

; MUI Settings
!define MUI_ABORTWARNING
!define MUI_ICON              "..\assets\icons\icon.ico"
!define MUI_UNICON             "..\assets\icons\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
!define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH

; Colors matching Apex Revenue dark theme
!define MUI_BGCOLOR               "0a0a0f"
!define MUI_TEXTCOLOR             "f0eeff"

; Welcome page
!define MUI_WELCOMEPAGE_TITLE     "Welcome to Apex Revenue Desktop"
!define MUI_WELCOMEPAGE_TEXT      "Creator Intelligence Engine v${PRODUCT_VERSION}$\r$\n$\r$\nAWS-Powered analytics for live cam performers.$\r$\n$\r$\n• Bedrock AI tip prompts (Claude Haiku)$\r$\n• Polly voice alerts$\r$\n• S3 session backup$\r$\n• CloudWatch live metrics$\r$\n• Kinesis Firehose event streaming$\r$\n• IoT Core dual-device relay$\r$\n$\r$\nClick Next to continue."

; Finish page
!define MUI_FINISHPAGE_TITLE      "Installation Complete"
!define MUI_FINISHPAGE_TEXT       "Apex Revenue Desktop has been installed.$\r$\n$\r$\nLaunch it from your Desktop shortcut or Start Menu."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT   "Launch Apex Revenue"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_LINK       "Visit apexrevenue.works"
!define MUI_FINISHPAGE_LINK_LOCATION "https://apexrevenue.works"

; ── Pages ─────────────────────────────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE     "..\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; ── Languages ─────────────────────────────────────────────────────────────────
!insertmacro MUI_LANGUAGE "English"

; ════════════════════════════════════════════════════════════════════════════
; INSTALLER SECTIONS
; ════════════════════════════════════════════════════════════════════════════

Section "Apex Revenue Desktop (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; ── Main executable ────────────────────────────────────────────────────────
  File "..\dist\win-unpacked\Apex Revenue.exe"

  ; ── Electron runtime files ─────────────────────────────────────────────────
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

  ; ── Locales ────────────────────────────────────────────────────────────────
  SetOutPath "$INSTDIR\locales"
  File /r "..\dist\win-unpacked\locales\*.*"

  ; ── App resources (asar — contains all source + AWS SDK) ───────────────────
  SetOutPath "$INSTDIR\resources"
  File /r "..\dist\win-unpacked\resources\*.*"

  ; ── Registry: installation path ────────────────────────────────────────────
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "Version"    "${PRODUCT_VERSION}"

  ; ── Registry: Add/Remove Programs entry ────────────────────────────────────
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "URLInfoAbout"    "${PRODUCT_URL}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoModify"        1
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoRepair"        1

  ; Calculate install size for Add/Remove Programs
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "EstimatedSize" "$0"

  ; ── Uninstaller ────────────────────────────────────────────────────────────
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; ── Desktop shortcut ───────────────────────────────────────────────────────
  CreateShortcut "$DESKTOP\Apex Revenue.lnk" \
    "$INSTDIR\${PRODUCT_EXE}" \
    "" \
    "$INSTDIR\${PRODUCT_EXE}" \
    0 \
    SW_SHOWNORMAL \
    "" \
    "Apex Revenue — Creator Intelligence Engine"

  ; ── Start Menu ─────────────────────────────────────────────────────────────
  CreateDirectory "$SMPROGRAMS\Apex Revenue"
  CreateShortcut "$SMPROGRAMS\Apex Revenue\Apex Revenue.lnk" \
    "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Apex Revenue\Uninstall.lnk" \
    "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  CreateShortcut "$SMPROGRAMS\Apex Revenue\ApexRevenue.works.lnk" \
    "${PRODUCT_URL}"

SectionEnd

; ════════════════════════════════════════════════════════════════════════════
; LAUNCH FUNCTION (finish page "Launch" button)
; ════════════════════════════════════════════════════════════════════════════
Function LaunchApp
  ExecShell "" "$INSTDIR\${PRODUCT_EXE}"
FunctionEnd

; ════════════════════════════════════════════════════════════════════════════
; UNINSTALLER
; ════════════════════════════════════════════════════════════════════════════
Section "Uninstall"

  ; Stop running instances
  ExecWait 'taskkill /F /IM "Apex Revenue.exe"' $0

  ; Remove all installed files
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

  ; Remove Start Menu folder
  Delete "$SMPROGRAMS\Apex Revenue\Apex Revenue.lnk"
  Delete "$SMPROGRAMS\Apex Revenue\Uninstall.lnk"
  Delete "$SMPROGRAMS\Apex Revenue\ApexRevenue.works.lnk"
  RMDir  "$SMPROGRAMS\Apex Revenue"

  ; Remove Desktop shortcut
  Delete "$DESKTOP\Apex Revenue.lnk"

  ; Remove registry entries
  DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"

SectionEnd
