# Cloud Dynasty Sleeper → GitHub Sync Design

## Goal
Keep Cloud Dynasty League `1389332241724764160` synchronized from Sleeper into GitHub with no recurring local-machine dependency.

## Architecture
GitHub Actions runs a dependency-free Python script every six hours and on manual dispatch. The script reads Sleeper's public, read-only API and writes deterministic JSON into `data/`. The workflow commits and pushes only when those tracked JSON files actually change, making Git history the archive of state changes.

## Data captured
- League metadata, settings, scoring, and roster positions
- League users/owners
- Rosters, including starters, reserve, taxi, and other Sleeper-native roster fields
- Traded draft picks
- NFL state
- All drafts attached to the league and their picks
- Transactions for fantasy weeks 1–18, stored both per-week and as a deduplicated combined file

## Storage behavior
The repository stores current canonical JSON, not timestamped duplicate snapshots. Git commit history supplies historical versions. Output JSON uses stable formatting and sorted keys so unchanged Sleeper data does not create commits.

## Reliability
The sync collects all remote responses before writing files, so a failed API call aborts the run instead of knowingly publishing a partial snapshot. HTTP failures exit non-zero, causing the GitHub Action to fail visibly.

## Credentials
No Sleeper token or secret is required because the Sleeper API is read-only. GitHub Actions uses the repository-scoped `GITHUB_TOKEN` with `contents: write` permission to commit updated data.

## Scope
This first version syncs the current league ID supplied by the user. It does not recursively backfill prior-season league IDs or store Sleeper's entire NFL player database.
