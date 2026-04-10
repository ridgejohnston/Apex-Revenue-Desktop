; ──────────────────────────────────────────────────────────
; Apex Revenue Desktop — Custom NSIS Installer Script
; ──────────────────────────────────────────────────────────
; This file is included by electron-builder's NSIS target.
; It adds custom installer behavior for OBS integration.

!macro customInit
  ; Check for Visual C++ Redistributable (required by obs-studio-node)
  ; obs-studio-node bundles libobs which depends on MSVC runtime
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 != "1"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Apex Revenue Desktop requires the Visual C++ Redistributable.$\n$\n\
       It doesn't appear to be installed. The app may not work without it.$\n$\n\
       Would you like to continue anyway? You can install it later from:$\n\
       https://aka.ms/vs/17/release/vc_redist.x64.exe" \
      IDYES continueInstall
    Abort
    continueInstall:
  ${EndIf}
!macroend

!macro customInstall
  ; Register the app to allow camera/microphone access on Windows
  ; Write a firewall exception for the RTMP streaming
  ; (Windows Firewall may block outbound RTMP connections)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Apex Revenue Desktop" dir=out action=allow program="$INSTDIR\Apex Revenue Desktop.exe" enable=yes'
!macroend

!macro customUnInstall
  ; Remove firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Apex Revenue Desktop"'
!macroend
