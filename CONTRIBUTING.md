# Contributing

Thanks for helping improve PixelQ.

## Before You Start

- Open an issue or discussion for larger changes so the direction is clear.
- Keep the project focused on responsible browser-based image workflow automation.
- Do not add features that encourage bypassing provider safeguards, account sharing, or abusive automation.

## Development Setup

### Desktop app

```powershell
cd app
go test ./...
pnpm --dir frontend install
pnpm --dir frontend build
powershell -ExecutionPolicy Bypass -File .\build-release.ps1 -OutputName pixelq-desktop-dev
```

### Extension and local tooling

```powershell
pnpm install
npm run test:detector
```

Optional local helpers:

- `npm run debug:extension`
- `npm run test:e2e:live`

## Pull Requests

- Keep PRs focused. Smaller changes are much easier to review.
- Update docs when behavior, setup, or supported providers change.
- Include the reasoning behind UX or automation behavior changes.
- If a change affects queue execution, downloads, or catalog ingestion, mention how you tested it.

## Code Style

- Prefer small, explicit changes over broad rewrites.
- Preserve existing patterns unless the change is intentionally refactoring them.
- Avoid committing generated build output, local profiles, logs, or temporary debug files.

## Responsible Use

PixelQ automates actions in third-party web interfaces. Contributions should respect platform terms, rate limits, safety systems, and user consent.
