# Apex Revenue Desktop

Professional streaming application with OBS integration for Chaturbate broadcasters. Built on Electron + obs-studio-node (libobs).

## Features

- **OBS-powered streaming** via libobs — same engine that powers OBS Studio and Streamlabs
- **Chaturbate RTMP integration** — paste your broadcast token and go live
- **Source management** — webcam, display capture, image/video overlays
- **Hardware encoding** — x264 (CPU), NVENC (NVIDIA GPU), Quick Sync (Intel)
- **Local recording** — MKV, MP4, FLV output alongside streaming
- **Stream health monitoring** — real-time bitrate, FPS, and status

## Prerequisites

- **Windows 10/11** or **macOS 12+**
- **Node.js 18+** and **npm**
- A Chaturbate broadcaster account with external encoder access

## Setup

```bash
git clone https://github.com/ridgejohnston/Apex-Revenue-Desktop.git
cd Apex-Revenue-Desktop
npm install
npm start
```

## Development

```bash
npm run dev    # Start with DevTools open
```

## Building

```bash
npm run build:win   # Windows installer
npm run build:mac   # macOS DMG
```

## Architecture

```
src/
  main/
    main.js          # Electron main process, IPC handlers
    preload.js       # Context bridge (renderer <-> main)
  obs/
    obs-manager.js   # Core libobs wrapper (scenes, sources, encoders, outputs)
    stream-service.js # Chaturbate RTMP streaming service
  renderer/
    index.html       # UI layout
    styles.css       # Dark theme
    renderer.js      # UI logic, IPC calls
```

### Key Integration: obs-studio-node

The app uses `@streamlabs/obs-studio-node` which provides Node.js bindings to `libobs` — the core library behind OBS Studio. All OBS operations run in the Electron **main process** and communicate with the renderer via IPC.

**Streaming flow:**
1. `obs-manager.js` initializes libobs, creates scenes + sources
2. `stream-service.js` configures RTMP output to `rtmp://global.live.mmcdn.com/live-origin`
3. User pastes their Chaturbate broadcast token and clicks "Go Live"
4. libobs handles encoding (x264/NVENC) and pushes the RTMP stream

## Configuration

Settings are persisted in `electron-store` at:
- **Windows:** `%APPDATA%/apex-revenue-desktop/`
- **macOS:** `~/Library/Application Support/apex-revenue-desktop/`

## License

MIT
