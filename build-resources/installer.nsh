; Apex Revenue — Custom NSIS Install Script
; Downloads FFmpeg from AWS S3 during installation (fresh install only)

!macro customInstall
  CreateDirectory "$INSTDIR\ffmpeg"

  ; Skip FFmpeg download on updates — it's already installed.
  ; Only download on a fresh install (ffmpeg.exe not yet present).
  IfFileExists "$INSTDIR\ffmpeg\ffmpeg.exe" ffmpeg_already_present

  DetailPrint "Downloading FFmpeg (required for streaming)..."

  ; Use PowerShell to download and extract the FFmpeg bundle from S3
  nsExec::ExecToLog `powershell.exe -ExecutionPolicy Bypass -Command " \
    try { \
      $$zipDest = '$INSTDIR\ffmpeg\ffmpeg-bundle.zip'; \
      Invoke-WebRequest -Uri 'https://apex-revenue-downloads.s3.us-east-1.amazonaws.com/ffmpeg/ffmpeg-bundle.zip' \
        -OutFile $$zipDest -UseBasicParsing; \
      Expand-Archive -LiteralPath $$zipDest -DestinationPath '$INSTDIR\ffmpeg' -Force; \
      Remove-Item $$zipDest -Force; \
      exit 0 \
    } catch { \
      exit 1 \
    }"`
  Pop $0

  ${If} $0 != 0
    DetailPrint "FFmpeg download failed — will be downloaded automatically on first launch."
  ${Else}
    DetailPrint "FFmpeg installed successfully."
  ${EndIf}

  Goto ffmpeg_done

  ffmpeg_already_present:
    DetailPrint "FFmpeg already installed — skipping download."

  ffmpeg_done:
!macroend

!macro customUnInstall
  ; Clean up FFmpeg on uninstall
  RMDir /r "$INSTDIR\ffmpeg"
!macroend
