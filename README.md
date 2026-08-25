# Cloud Dynasty Sleeper Sync

GitHub-native, automatic backup/sync of the **Cloud Dynasty** Sleeper league.

- **Sleeper League ID:** `1389332241724764160`
- **Storage:** GitHub repository only
- **Schedule:** every 6 hours + manual runs
- **Sleeper credentials:** none required
- **Local machine:** not required after initial GitHub setup

Sleeper documents its API as read-only and unauthenticated: https://docs.sleeper.com/

## What gets synchronized

Current canonical JSON is kept under `data/`:

```text
data/
├── league.json
├── nfl_state.json
├── rosters.json
├── traded_picks.json
├── users.json
├── drafts/
│   ├── index.json
│   └── <draft_id>_picks.json
└── transactions/
    ├── all.json
    └── by_week/
        ├── week_01.json
        ├── ...
        └── week_18.json
```

The sync preserves Sleeper's roster payload as-is, including fields such as `starters`, `reserve`, and `taxi` when Sleeper returns them. This means the live Sleeper settings and roster structure—not an older written charter—are what the repository captures.

## How history works

This repository intentionally does **not** create timestamped duplicate snapshots. Each run writes the current version of each JSON file. If nothing changed, no commit is created.

When league data changes, GitHub Actions commits the new files. Git history therefore becomes the historical record and lets you compare any two synced points in time.

## Automation

`.github/workflows/sleeper-sync.yml` runs:

1. the unit tests;
2. the Sleeper sync;
3. `git add data/`;
4. a commit and push only if data changed.

The workflow can also be run manually from GitHub's **Actions** tab.

## Repository layout

```text
.github/workflows/sleeper-sync.yml  # scheduled/manual automation
config.json                          # Cloud Dynasty league ID
sync/sync_sleeper.py                 # Sleeper API client + deterministic writer
tests/test_sync_sleeper.py           # behavior tests
data/                                 # created by the first successful sync
SETUP.md                              # one-time setup instructions
```

## Changing the league

Edit `config.json`:

```json
{
  "league_id": "1389332241724764160"
}
```

No GitHub Secret is necessary.

## Scope note

Version 1 synchronizes this current league ID from the point you turn the workflow on. It does not recursively backfill older Sleeper league IDs from prior seasons, and it does not download Sleeper's full NFL player database on every six-hour run.
