# Cloud Dynasty Sleeper → GitHub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub-native scheduled sync for Cloud Dynasty League `1389332241724764160` that stores current Sleeper JSON and commits only real data changes.

**Architecture:** A dependency-free Python client reads the public Sleeper API, materializes deterministic files under `data/`, and exits non-zero on fetch failure. A GitHub Actions workflow runs it every six hours or manually and commits only staged data differences.

**Tech Stack:** Python 3.12 standard library, GitHub Actions, JSON, unittest

**Spec:** `docs/superpowers/specs/2026-08-25-sleeper-github-sync-design.md`

## Global Constraints
- League ID is `1389332241724764160`.
- No Sleeper credentials or paid service.
- No recurring local-machine dependency.
- Current-state JSON only; Git history is the archive.
- Normal scheduled sync must not download the full NFL player database.
- Schedule every six hours plus manual dispatch.
- Dependency-free Python standard library only.

---

### Task 1: Deterministic snapshot collector

**Files:**
- Create: `sync/sync_sleeper.py`
- Create: `config.json`
- Test: `tests/test_sync_sleeper.py`

**Interfaces:**
- Produces `collect_snapshot(league_id, fetcher)` returning `{relative_path: JSON-serializable payload}`.
- Produces `write_snapshot(root, snapshot)` writing deterministic JSON.

- [ ] Write failing tests for endpoint collection, transaction deduplication, stable JSON output, and stale generated-file cleanup.
- [ ] Run tests and verify failure because production module does not exist.
- [ ] Implement the minimum standard-library sync code.
- [ ] Run tests and verify all pass.
- [ ] Commit the tested collector.

### Task 2: GitHub Actions automation

**Files:**
- Create: `.github/workflows/sleeper-sync.yml`
- Create: `.gitignore`

**Interfaces:**
- Workflow runs `python sync/sync_sleeper.py`.
- Workflow stages `data/`, commits only when staged changes exist, and pushes with `GITHUB_TOKEN`.

- [ ] Add scheduled and manual workflow configuration.
- [ ] Validate workflow YAML structure and required fields locally.
- [ ] Commit automation configuration.

### Task 3: Operator documentation and distributable package

**Files:**
- Create: `README.md`
- Create: `SETUP.md`

**Interfaces:**
- README explains architecture and repository contents.
- SETUP gives browser-first GitHub setup and first-run verification steps.

- [ ] Write repository documentation.
- [ ] Run the full test suite and syntax checks.
- [ ] Package repository contents into an upload-ready ZIP without `.git` or generated cache files.
