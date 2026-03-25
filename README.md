# PixelQ

> Browser-based image generation automation for people who want a queue, not a babysitting session.

[![Latest Release](https://img.shields.io/github/v/release/hrmasss/pixelq?label=latest%20release)](https://github.com/hrmasss/pixelq/releases/latest)
[![License](https://img.shields.io/github/license/hrmasss/pixelq)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%2B%20Chrome-0f172a)](#download-and-install)
[![Provider](https://img.shields.io/badge/provider-ChatGPT%20today%2C%20more%20WIP-c2410c)](#supported-providers)

PixelQ helps automate image generation through web interfaces.

Right now it is built around **ChatGPT on the web**, with a **Chrome extension** that can work on its own or connect to a **Windows desktop app** for queue management, downloads, templates, and a local image library.

This project is especially useful if you generate lots of images through the browser and want to stop repeating the same manual steps over and over.

## What PixelQ Is Good For

PixelQ is designed for workflows like:

- queuing multiple image prompts instead of waiting on each one by hand
- running overnight or long sessions with cooldowns and retries
- downloading finished images into a structured local library
- testing prompt variations in batches
- using reusable templates or CSV-based runs for repeatable prompt systems
- keeping a local desktop view of queue state, failures, and completed work

## Supported Providers

- `ChatGPT`: supported now
- Other web-interface providers: work in progress

The system is intentionally structured so provider support can expand over time, but today the primary supported workflow is ChatGPT image generation in Chrome.

## Responsible Use

PixelQ automates actions in third-party web interfaces. That means:

- your usage is still subject to the provider's Terms of Service and acceptable use policies
- you are responsible for using it within platform rules, limits, and safety systems
- PixelQ should not be used to spam, overload, evade safeguards, or automate activity that would violate the platform's rules if done manually

Use it responsibly and respectfully.

## Download And Install

### Fast path

Download the latest release assets:

- [Desktop app (.exe)](https://github.com/hrmasss/pixelq/releases/download/v0.1.1-alpha/pixelq-desktop-0.1.1-alpha.exe)
- [Extension (.zip)](https://github.com/hrmasss/pixelq/releases/download/v0.1.1-alpha/pixelq-extension-0.1.1-alpha.zip)
- [All releases](https://github.com/hrmasss/pixelq/releases)

### For non-technical users

1. Download the desktop app `.exe` from the release page.
2. Download the extension `.zip`.
3. Extract the extension zip somewhere permanent on your computer.
4. Open Chrome and go to `chrome://extensions/`.
5. Turn on **Developer mode**.
6. Click **Load unpacked** and choose the extracted extension folder.
7. Open ChatGPT in Chrome and sign in.
8. Launch the PixelQ desktop app.
9. Keep a ChatGPT tab open, then queue prompts from the extension or desktop app.

### What gets installed where

- The desktop app manages queue state and a local library.
- By default, the image library is stored in `Pictures\PixelQ`.
- Downloads first land in `Downloads\PixelQ\_inbox` and are then organized into the library.

## How It Works

PixelQ has two parts:

### Chrome extension

The extension:

- talks to the supported web interface
- submits prompts
- detects when generation is complete
- downloads image outputs
- can run standalone or bridge back to the desktop app

### Desktop app

The desktop app:

- shows queue, failures, and completed jobs
- stores local templates and batch input
- organizes finished images into a local library
- exposes a local REST API
- exposes MCP tools for external automation

## Feature Overview

### Desktop app

- queue monitoring and control
- reusable prompt templates
- CSV-assisted batch runs
- local image catalog
- path and runtime settings
- local API and MCP integration

### Extension

- quick single-run creation
- batch queueing
- ChatGPT tab detection
- completion detection and auto-download
- desktop bridge sync

## Screens And Workflow

The intended flow is simple:

1. Open ChatGPT in Chrome
2. Start PixelQ
3. Queue prompts from the extension or the desktop app
4. Let PixelQ submit jobs one by one
5. Review completed assets in the desktop library

This makes PixelQ a good fit for creators, designers, prompt iterators, content teams, and anyone doing repeated browser-based image generation work.

## Developer Setup

### Requirements

- Windows
- Go
- Node.js
- pnpm
- Chrome
- Wails CLI for desktop builds

### Desktop app

```powershell
cd app
go test ./...
pnpm --dir frontend install
pnpm --dir frontend build
powershell -ExecutionPolicy Bypass -File .\build-release.ps1 -OutputName pixelq-desktop-dev
```

### Extension and root tooling

```powershell
pnpm install
npm run test:detector
```

Useful helper commands:

- `npm run debug:extension`
- `npm run test:detector`
- `npm run test:e2e:live`

## Local API

The desktop daemon exposes a local API on `http://127.0.0.1:8765` by default.

Example:

```bash
# Queue one job
curl -X POST http://127.0.0.1:8765/jobs \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"Create a cinematic editorial perfume image\"}"

# Queue a batch
curl -X POST http://127.0.0.1:8765/jobs/batch \
  -H "Content-Type: application/json" \
  -d "{\"jobs\":[{\"prompt\":\"Prompt 1\"},{\"prompt\":\"Prompt 2\"}]}"

# Check status
curl http://127.0.0.1:8765/status
```

## MCP

Run the MCP server from the desktop app module:

```powershell
cd app
go run . mcp
```

Example config:

```json
{
  "mcpServers": {
    "pixelq": {
      "command": "C:/path/to/pixelq.exe",
      "args": ["mcp"]
    }
  }
}
```

## Release Packaging

From the repo root:

```powershell
.\scripts\prepare-release.ps1
```

This produces:

- `releases/0.1.1-alpha/pixelq-desktop-0.1.1-alpha.exe`
- `releases/0.1.1-alpha/pixelq-extension-0.1.1-alpha.zip`

## Project Layout

```text
pixelq/
├── app/            # Wails desktop app, daemon, REST API, MCP server
├── extension/      # Chrome extension that automates the supported provider UI
├── assets/         # Shared branding and design assets
├── scripts/        # Packaging and local debug/test helpers
└── .references/    # Local reference material used during development
```

## Contributing

Contributions are welcome.

If you want to help:

- fix queueing or completion edge cases
- improve provider adapters
- improve onboarding and docs
- improve asset ingestion and desktop sync

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and contribution notes.

## License

PixelQ is licensed under the [MIT License](./LICENSE).
