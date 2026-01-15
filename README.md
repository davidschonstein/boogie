# Surf Foil Session Map (GitHub Pages + logs dropdown)

This is your interactive surf-foiling playback map, turned into a GitHub Pages site.

## What changed
- Adds a **Session dropdown** that lists all `.csv` files in the `/logs` folder of the repo.
- Selecting a file loads that session.

Everything else stays the same (play/pause, scrubber, speed, fade toggle, 10-minute fade, nav-mode colors, nav mode 7 distance labels).

## Repo structure
```
/
  index.html
  app.js
  styles.css
  logs/
    2026-01-11.csv
    2026-01-14.csv
```
Commit/push new CSVs to `logs/` and they’ll show up automatically.

## Deploy (GitHub Pages)
1. Create a repo (e.g. `surf-foil-map`)
2. Add these files to the repo root
3. Add CSVs into `logs/`
4. GitHub → Settings → Pages → Deploy from branch → `main` / root
5. Visit: `https://USERNAME.github.io/REPO/`

## Deep-link to a log
`...?log=FILENAME.csv`
