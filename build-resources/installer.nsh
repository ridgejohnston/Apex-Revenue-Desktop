; Apex Revenue — Custom NSIS Install Script
; Downloads FFmpeg from AWS S3 during installation

!macro customInstall
  ; Create FFmpeg directory inside install dir
  CreateDirectory "$INSTDIR\ffmpeg"

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
!macroend

!macro customUnInstall
  ; Clean up FFmpeg on uninstall
  RMDir /r "$INSTDIR\ffmpeg"
!macroend
