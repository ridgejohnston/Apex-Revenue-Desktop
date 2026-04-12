# Apex Revenue Desktop v2.0

**Creator Intelligence Engine + OBS Streaming Platform**

Apex Revenue is an Electron + React desktop app for content creators that combines real-time earnings analytics with a full OBS-style streaming platform.

## Features

### OBS Streaming Platform
- **Scene Management** — Unlimited scenes with layered sources, drag/reorder, rename, duplicate, studio mode
- **18 Source Types** — Webcam, screen/window/game capture, images, text, browser, color, media, Lovense overlay, tip goal, tip menu, chat overlay, alert box
- **Audio Mixer** — Per-source volume/mute, stereo level meters, noise gate/suppression/gain/compressor/limiter/EQ filters
- **RTMP Streaming** — Stream to any RTMP server (Chaturbate, Stripchat, CamSoda, BongaCams, Twitch, YouTube presets) via FFmpeg
- **Local Recording** — Record to MP4 with configurable quality
- **Virtual Camera** — Use your scene as a webcam in other apps
- **Transitions** — Cut, fade, slide, swipe, stinger with configurable durations
- **Canvas Preview** — 16:9 scene compositor with click-to-select, selection handles, live stats overlay

### Creator Intelligence Engine
- **Live Analytics** — Tokens/hour, viewers, conversion rate, session timer
- **Whale Tracker** — Real-time detection of high-value tippers with tier badges
- **Fan Leaderboard** — Ranked fan list with cumulative tips
- **AI Prompts** — Claude Haiku generates contextual monetization tips on behavioral triggers
- **Voice Alerts** — AWS Polly text-to-speech for prompts and whale notifications
- **Session Backup** — Automatic S3 backup of session data
- **40+ Platform Shortcuts** — Chaturbate, Stripchat, MyFreeCams, OnlyFans, Fansly, and more

### AWS Integrations
- **Bedrock** — AI-powered coaching via Claude 3 Haiku
- **Polly** — Neural voice synthesis (Joanna)
- **S3** — Session backup and app updates
- **CloudWatch** — Real-time metrics emission
- **Firehose** — Tip event streaming
- **IoT Core** — Lovense toy relay
- **Cognito** — JWT authentication

## Tech Stack

- **Electron 29** + **React 18** (Webpack)
- **FFmpeg** for RTMP streaming and recording
- **AWS SDK v3** for all cloud services
- **electron-store** for encrypted local persistence

## Getting Started

```bash
npm install
npm start
```

## Build Windows Installer

```bash
npm run build:win
```

Requires FFmpeg in the `ffmpeg/` folder or on system PATH for streaming/recording features.

## License

UNLICENSED — Copyright © 2025 Ridge Johnston
