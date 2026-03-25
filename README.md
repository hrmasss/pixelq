# PixelQ

PixelQ is a local-first ChatGPT image queue with two surfaces:

- A Windows desktop app built with Wails
- A Chrome extension that can run standalone or bridge into the desktop app

Version: `0.1 alpha`

## What Changed

- Desktop + extension only
- TUI removed
- Shared burning-rust branding and icons
- Simpler queue timing controls: cooldown, retries, and adaptive rate limiting
- Dark mode support plus translucent Windows 11-style desktop shell
- Keep-awake option in desktop settings for long-running queued work
- Release packaging for the desktop binary and extension zip

## Features

### Desktop app

- Queue monitoring and control
- Prompt template studio with reusable variables and run sets
- Local asset library
- Settings for theme, keep-awake, queue timing, paths, API, and MCP
- Local REST API
- MCP server over stdio

### Extension

- Queue management inside Chrome
- Quick prompts, template runs, and CSV import
- Shared visual language with the desktop app
- Standalone mode or desktop-bridged mode

## Quick Start

### Extension only

1. Open `chrome://extensions/`
2. Turn on Developer mode
3. Click Load unpacked
4. Select the [`extension`](./extension) folder
5. Open ChatGPT and start queueing prompts

### Desktop app

```powershell
cd app
.\build-release.ps1
.\build\bin\pixelq-desktop-0.1.0-alpha.exe
```

The desktop app starts the local daemon automatically and keeps the REST API available on `http://127.0.0.1:8765` by default.

## API

```bash
# Queue one job
curl -X POST http://127.0.0.1:8765/jobs \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"A cinematic rust-toned product render\"}"

# Queue a batch
curl -X POST http://127.0.0.1:8765/jobs/batch \
  -H "Content-Type: application/json" \
  -d "{\"jobs\":[{\"prompt\":\"Prompt 1\"},{\"prompt\":\"Prompt 2\"}]}"

# Status
curl http://127.0.0.1:8765/status
```

## MCP

Run:

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

Available tools focus on queueing jobs, template runs, status checks, and catalog lookup.

## Release Packaging

Prepare GitHub release artifacts from the repo root:

```powershell
.\scripts\prepare-release.ps1
```

This creates:

- `releases/0.1.0-alpha/pixelq-desktop-0.1.0-alpha.exe`
- `releases/0.1.0-alpha/pixelq-extension-0.1.0-alpha.zip`

## Project Structure

```text
pixelq/
├── app/                 # Wails desktop app, daemon, API, MCP
├── extension/           # Chrome extension
├── assets/branding/     # Shared logo source copied from references
├── scripts/             # Release packaging helpers
└── .references/         # Design/reference material
```

## Notes

- The extension can still operate without the desktop app.
- Desktop settings now own cooldown, retry, adaptive rate limiting, theme, and keep-awake behavior.
- Old build artifacts are ignored through `.gitignore`; use the release script for distributable outputs.
