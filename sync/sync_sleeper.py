#!/usr/bin/env python3
"""Synchronize a Sleeper league into deterministic JSON files for GitHub."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = "https://api.sleeper.app/v1"
TRANSACTION_WEEKS = range(1, 19)
JsonValue = Any
Fetcher = Callable[[str], JsonValue]


class SyncError(RuntimeError):
    """Raised when Sleeper data cannot be collected safely."""


def fetch_json(url: str) -> JsonValue:
    request = Request(url, headers={"User-Agent": "cloud-dynasty-sleeper-sync/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as exc:
        raise SyncError(f"Sleeper returned HTTP {exc.code} for {url}") from exc
    except URLError as exc:
        raise SyncError(f"Could not reach Sleeper for {url}: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise SyncError(f"Sleeper returned invalid JSON for {url}") from exc


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    league_id = str(config.get("league_id", "")).strip()
    if not league_id:
        raise SyncError(f"Missing league_id in {path}")
    config["league_id"] = league_id
    return config


def collect_snapshot(league_id: str, fetcher: Fetcher = fetch_json) -> dict[str, JsonValue]:
    league_url = f"{API_BASE}/league/{league_id}"
    snapshot: dict[str, JsonValue] = {}

    # Collect everything before writing anything. A failed call therefore cannot
    # publish a knowingly partial snapshot into the repository.
    snapshot["data/league.json"] = fetcher(league_url)
    snapshot["data/users.json"] = fetcher(f"{league_url}/users")
    snapshot["data/rosters.json"] = fetcher(f"{league_url}/rosters")
    snapshot["data/traded_picks.json"] = fetcher(f"{league_url}/traded_picks")
    snapshot["data/nfl_state.json"] = fetcher(f"{API_BASE}/state/nfl")

    drafts = fetcher(f"{league_url}/drafts")
    snapshot["data/drafts/index.json"] = drafts
    for draft in drafts:
        draft_id = str(draft["draft_id"])
        snapshot[f"data/drafts/{draft_id}_picks.json"] = fetcher(
            f"{API_BASE}/draft/{draft_id}/picks"
        )

    transactions_by_id: dict[str, JsonValue] = {}
    for week in TRANSACTION_WEEKS:
        transactions = fetcher(f"{league_url}/transactions/{week}")
        snapshot[f"data/transactions/by_week/week_{week:02d}.json"] = transactions
        for transaction in transactions:
            transaction_id = str(transaction.get("transaction_id", ""))
            if transaction_id:
                transactions_by_id[transaction_id] = transaction

    snapshot["data/transactions/all.json"] = sorted(
        transactions_by_id.values(),
        key=lambda item: (int(item.get("created") or 0), str(item.get("transaction_id") or "")),
        reverse=True,
    )
    return snapshot


def _json_bytes(payload: JsonValue) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def write_snapshot(root: Path, snapshot: dict[str, JsonValue]) -> bool:
    root = root.resolve()
    changed = False
    expected = {Path(relative_path) for relative_path in snapshot}

    generated_patterns = (
        (Path("data/drafts"), "*_picks.json"),
        (Path("data/transactions/by_week"), "week_*.json"),
    )
    for relative_dir, pattern in generated_patterns:
        directory = root / relative_dir
        if not directory.exists():
            continue
        for existing in directory.glob(pattern):
            relative = existing.relative_to(root)
            if relative not in expected:
                existing.unlink()
                changed = True

    for relative_path, payload in snapshot.items():
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        desired = _json_bytes(payload)
        if destination.exists() and destination.read_bytes() == desired:
            continue
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(desired)
        temporary.replace(destination)
        changed = True

    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root (defaults to the project containing this script).",
    )
    parser.add_argument("--league-id", help="Override the league_id in config.json.")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    config = load_config(root / "config.json")
    league_id = str(args.league_id or config["league_id"])

    try:
        snapshot = collect_snapshot(league_id)
        changed = write_snapshot(root, snapshot)
    except (SyncError, KeyError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    status = "updated" if changed else "unchanged"
    print(f"Sleeper league {league_id}: {status} ({len(snapshot)} files tracked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
