# Apex Revenue Desktop

**Creator Intelligence Engine for Windows** — a standalone Electron desktop app built from the [Apex Revenue Chrome Extension](https://github.com/ridgejohnston/Apex-Revenue-Edge).

---

## What It Does

Apex Revenue Desktop gives cam performers a persistent, always-on analytics HUD without needing a browser extension. Open it, navigate to your platform, and the analytics panel updates in real time.

| Feature | Details |
|---|---|
| **Live Analytics** | Tokens/hr, viewers, conversion rate — live |
| **Whale Tracker** | Top tippers flagged the moment they tip |
| **Fan Leaderboard** | Ranked fan list with tier badges |
| **AI Prompts** | Behavioral signal engine surfaces monetization cues |
| **Session Timer** | Tracks peak viewers, avg tip size, total tokens |
| **Embedded Browser** | Opens Chaturbate, Stripchat, MyFreeCams, xTease natively |
| **AWS Cognito Auth** | Same account as the Chrome extension |
| **System Tray** | Runs in background, always accessible |

---

## Supported Platforms

- Chaturbate
- Stripchat
- MyFreeCams
- xTease

---

## Architecture

```
apex-revenue-desktop/
├── main/
│   └── main.js              # Electron main process (windows, IPC, tray, store)
├── preload/
│   ├── preload-main.js      # contextBridge for main renderer window
│   └── preload-cam.js       # Injected into cam platform BrowserView (DOM scraper)
├── renderer/
│   ├── index.html           # App shell (titlebar, platform bar, analytics panel)
│   ├── app.js               # Renderer logic (live data, UI, auth, AI prompts)
│   └── app.css              # Styles (dark luxury theme)
├── overlay/                 # Reserved for floating overlay window (v2)
├── shared/
│   ├── auth.js              # AWS Cognito auth (adapted from extension)
│   ├── apex-config.js       # Extension ID / version constants
│   ├── earnings-tracker.js  # Session earnings accumulator
│   ├── billing-manager.js   # Stripe subscription gate
│   └── data-sync.js         # Backup / export / restore
└── assets/icons/            # App icons (PNG + ICO)
```

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode
npm start

# Build Windows installer
npm run build:win
```

Requires Node.js 18+ and npm.

---

## How It Works

1. **BrowserView** embeds the cam platform page — same as navigating in Chrome, but inside the app.
2. **`preload-cam.js`** is injected into that BrowserView as a preload script. It:
   - Patches `WebSocket` to intercept tip messages in real time
   - Polls the DOM every 3 seconds for viewer count, fan list, chat
   - Sends structured `cam:live-update` events via `ipcRenderer` to the main process
3. **Main process** stores the data in `electron-store` and forwards to the renderer window.
4. **Analytics panel** (right side of the app) receives updates and renders live stats.

---

## Backend

Uses the same AWS infrastructure as the Chrome extension:
- **AWS Cognito** (`us-east-1_EjYUEgmKm`) for auth
- **API Gateway** (`7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod`) for subscriptions, earnings, backups
- **PostHog** for analytics

---

## Building the Installer

```bash
npm run build:win
```

Outputs: `dist/ApexRevenue-Setup-1.0.0.exe` (NSIS installer, Windows x64)

---

## Related Repos

| Repo | Description |
|---|---|
| [Apex-Revenue-Edge](https://github.com/ridgejohnston/Apex-Revenue-Edge) | Chrome MV3 extension (source of truth) |
| [ApexSensations](https://github.com/ridgejohnston/ApexSensations) | Chaturbate CB App + toy control |
| [ApexFrenzy](https://github.com/ridgejohnston/ApexFrenzy) | Spin-the-wheel CB App |
| [apexrevenue-website](https://github.com/ridgejohnston/apexrevenue-website) | Marketing site on AWS Amplify |

---

*Apex Revenue Desktop — by Ridge Johnston*
