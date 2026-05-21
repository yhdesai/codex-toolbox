# Codex Sync for iPhone and Apple Watch

SwiftUI client for the Codex Toolbox Watch API.

## What It Does

- Start a Codex session from iPhone or Apple Watch.
- Pick a configured project/repo.
- Use task presets for common actions.
- Type or dictate a prompt on Apple Watch.
- Poll active sessions and show compact status.
- Put `Needs You` sessions first.
- Reply to Codex from iPhone or Apple Watch.
- Interrupt a running session.

## Requirements

- Xcode 15 or newer.
- iOS 17 or newer.
- watchOS 10 or newer.
- Codex Toolbox running with `CODEX_WATCH_API_PORT` enabled.

## Generate the Xcode Project

This folder includes an XcodeGen spec:

```sh
cd apps/apple
xcodegen generate
open CodexSync.xcodeproj
```

If you do not use XcodeGen, create an iOS SwiftUI app target and a watchOS SwiftUI app target in Xcode, then add:

```text
Shared/*.swift
iOS/*.swift      -> iOS target only
Watch/*.swift   -> watchOS target only
```

## Backend Setup

Run Codex Toolbox with the Watch API enabled:

```sh
CODEX_WATCH_API_PORT=8787 \
CODEX_WATCH_API_HOST=0.0.0.0 \
CODEX_WATCH_API_TOKEN=replace-me \
CODEX_WATCH_PROJECTS="toolbox=/home/yash/projects-shiprdev/codex-sync" \
npm start
```

For a real iPhone or Apple Watch, `127.0.0.1` points at the device, not your Mac/server. Use a LAN IP, Tailscale IP, or private tunnel URL in the app settings. Keep `CODEX_WATCH_API_TOKEN` enabled when the API is reachable off-machine.

Example app settings:

```text
API URL: http://192.168.1.20:8787
Token: replace-me
```

## Watch Flow

1. Open Codex on Apple Watch.
2. Tap `New Task`.
3. Pick a repo.
4. Choose a preset such as `Fix Bug`, `Investigate`, `Review PR`, `Run Tests`, or `Ship`.
5. Dictate or type the final prompt.
6. Tap `Start`.
7. Open the session to see `Working`, `Testing`, `Needs You`, `Done`, or `Failed`.
8. Reply, follow up, or interrupt from the watch.
