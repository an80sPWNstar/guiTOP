# guiTOP — Session Handoff

_Last updated: 2026-07-19 v0.2.3. Read this + `CLAUDE.md` once at session start._

## Current State

### v0.2.3 — Claude usage + Linux builds (this session)
- Claude usage strip: replaced local JSONL scanner with `cswap list --json` polling
- Session/Week percentages now match online Claude account (not local transcript heuristics)
- Display name: `GUITOP_DISPLAY_NAME=an80sPWNstar` set in main.js (privacy)
- Linux builds: AppImage (107MB, CachyOS/Arch) + .deb (74MB, Ubuntu/Debian)
- New build scripts: `build:win` (WSL→PowerShell), `build:linux` (native)
- Version bumped to 0.2.3 — tag + GitHub release with all 3 installers

### v0.2.2 — Claude usage strip (prior session)
- Full Claude usage + swap strip integration (15 files)
- Session/week/reset/today meters + per-account cswap chips
- Dockable: top/bottom/off, persisted in localStorage
- Skinned for bars/gauges/corvette themes
- Gap: autoOn hardcoded false (cswap auto daemon detection not implemented)

### Inherited (prior)
- Three skins: Bars, Gauges, C4 Corvette (dropdown selector)
- Process table with sortable columns (GPU|PID|USER|CPU%|MEM%|TIME|PROCESS|VRAM)
- Host management UI: Add/Remove/Reconnect with SSH fingerprint verification
- Dev HTTP server on port 17580: screenshot, skin/tab/host/claude endpoints
- Electron 31, ssh2 transport, safeStorage for passwords

## Disk Layout
- **Source**: `E:\vs_code_projects\guiTOP\`
- **WSL path**: `/mnt/e/vs_code_projects/guiTOP/`
- **GitHub**: `an80sPWNstar/guiTOP` (fork)
- **GitHub token**: in `~/.hermes/.env` as GITHUB_TOKEN
- **Build output**: `dist\guiTOP Setup 0.2.3.exe` (78MB), `dist/guiTOP-0.2.3.AppImage` (107MB), `dist/guitop_0.2.3_amd64.deb` (74MB)

## Git
```
an80sPWNstar/guiTOP, branch main
Commits this session:
  ff62287 chore: add build:win and build:linux scripts
  cb96e9e feat: add Linux builds (AppImage + deb)
  b83ef86 chore: bump to v0.2.3
  77747d9 fix: account display name (an80sPWNstar)
  cfc19de fix: Claude usage from cswap (matches online account)
  494d99a feat: Claude Code usage + swap strip integration
```

## Sibling Project
- **guiHTOP** at `E:\vs_code_projects\guiHTOP\` — same architecture, monitors Linux /proc stats
- This session: ported Claude usage/swap integration to guiHTOP (3 new files + 4 wired)
