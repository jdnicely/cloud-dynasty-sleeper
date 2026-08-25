#!/usr/bin/env python3
"""Synchronize a Sleeper league into deterministic JSON files for GitHub."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = "https://api.sleeper.app/v1"
TRANSACTION_WEEKS = range(1, 19)
JsonValue = Any
Fetcher = Callable[[str], JsonValue]


class SyncError(RuntimeError):
    """Raised when Sleeper data cannot be collected safely."""


def fetch_json(url: str) -> JsonValue:
    request = Request(url, headers={"User-Agent": "cloud-dynasty-sleeper-sync/2.0"})
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


def load_player_map(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SyncError(f"Could not read cached player map from {path}") from exc
    if not isinstance(payload, dict):
        raise SyncError(f"Cached player map in {path} must be a JSON object")
    return payload


def _player_name(player_id: str, player: dict[str, Any] | None) -> str:
    if player_id == "0":
        return "EMPTY"
    if player:
        full_name = str(player.get("full_name") or "").strip()
        if full_name:
            return full_name
        first = str(player.get("first_name") or "").strip()
        last = str(player.get("last_name") or "").strip()
        combined = " ".join(part for part in (first, last) if part)
        if combined:
            return combined
    if player_id.isalpha() and 2 <= len(player_id) <= 4:
        return f"{player_id} D/ST"
    return player_id


def _resolve_player(player_id: str, player_map: dict[str, Any], starter_slot: str | None = None) -> dict[str, Any]:
    player = player_map.get(player_id)
    if not isinstance(player, dict):
        player = None

    resolved = {
        "player_id": player_id,
        "name": _player_name(player_id, player),
        "position": (player or {}).get("position"),
        "team": (player or {}).get("team"),
        "fantasy_positions": (player or {}).get("fantasy_positions"),
        "status": (player or {}).get("status"),
        "injury_status": (player or {}).get("injury_status"),
        "active": (player or {}).get("active"),
    }
    if player_id.isalpha() and 2 <= len(player_id) <= 4 and resolved["position"] is None:
        resolved["position"] = "DEF"
        resolved["team"] = player_id
    if starter_slot is not None:
        resolved["starter_slot"] = starter_slot
    return resolved


def _owner_summary(user_id: str | None, users_by_id: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    if not user_id:
        return None
    user = users_by_id.get(str(user_id), {})
    metadata = user.get("metadata") if isinstance(user.get("metadata"), dict) else {}
    return {
        "user_id": str(user_id),
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "team_name": metadata.get("team_name"),
    }


def resolve_rosters(
    league: dict[str, Any],
    rosters: list[dict[str, Any]],
    users: list[dict[str, Any]],
    player_map: dict[str, Any],
) -> dict[str, Any]:
    """Build a human-readable roster view while preserving Sleeper IDs."""

    users_by_id = {
        str(user.get("user_id")): user
        for user in users
        if isinstance(user, dict) and user.get("user_id") is not None
    }
    roster_positions = [str(position) for position in (league.get("roster_positions") or [])]
    starter_slots = [position for position in roster_positions if position != "BN"]

    resolved_rosters: list[dict[str, Any]] = []
    for roster in rosters:
        players = [str(pid) for pid in (roster.get("players") or [])]
        starters = [str(pid) for pid in (roster.get("starters") or [])]
        reserve = [str(pid) for pid in (roster.get("reserve") or [])]
        taxi = [str(pid) for pid in (roster.get("taxi") or [])]
        occupied = set(starters) | set(reserve) | set(taxi)
        bench = [pid for pid in players if pid not in occupied]

        starter_entries = []
        for index, player_id in enumerate(starters):
            slot = starter_slots[index] if index < len(starter_slots) else None
            starter_entries.append(_resolve_player(player_id, player_map, slot))

        co_owner_ids = [str(uid) for uid in (roster.get("co_owners") or [])]
        resolved_rosters.append(
            {
                "roster_id": roster.get("roster_id"),
                "owner": _owner_summary(roster.get("owner_id"), users_by_id),
                "co_owners": [
                    owner
                    for owner in (_owner_summary(uid, users_by_id) for uid in co_owner_ids)
                    if owner is not None
                ],
                "settings": roster.get("settings") or {},
                "starters": starter_entries,
                "bench": [_resolve_player(pid, player_map) for pid in bench],
                "reserve": [_resolve_player(pid, player_map) for pid in reserve],
                "taxi": [_resolve_player(pid, player_map) for pid in taxi],
                "all_players": [_resolve_player(pid, player_map) for pid in players],
            }
        )

    return {
        "league_id": str(league.get("league_id") or ""),
        "league_name": league.get("name"),
        "season": league.get("season"),
        "roster_positions": roster_positions,
        "starter_slots": starter_slots,
        "rosters": resolved_rosters,
    }


def _collect_player_ids_from_transactions(transactions: Iterable[dict[str, Any]]) -> set[str]:
    player_ids: set[str] = set()
    for transaction in transactions:
        for field in ("adds", "drops"):
            mapping = transaction.get(field)
            if isinstance(mapping, dict):
                player_ids.update(str(player_id) for player_id in mapping)
    return player_ids


def referenced_player_ids(
    rosters: list[dict[str, Any]],
    draft_picks: list[dict[str, Any]],
    transactions: list[dict[str, Any]],
) -> set[str]:
    ids: set[str] = set()
    for roster in rosters:
        for field in ("players", "starters", "reserve", "taxi"):
            ids.update(str(player_id) for player_id in (roster.get(field) or []))
    for pick in draft_picks:
        if pick.get("player_id") is not None:
            ids.add(str(pick["player_id"]))
    ids.update(_collect_player_ids_from_transactions(transactions))
    ids.discard("0")
    return ids


def collect_snapshot(
    league_id: str,
    fetcher: Fetcher = fetch_json,
    *,
    player_map: dict[str, Any] | None = None,
    refresh_players: bool = False,
) -> dict[str, JsonValue]:
    league_url = f"{API_BASE}/league/{league_id}"
    snapshot: dict[str, JsonValue] = {}

    # Collect everything before writing anything. A failed call therefore cannot
    # publish a knowingly partial snapshot into the repository.
    league = fetcher(league_url)
    users = fetcher(f"{league_url}/users")
    rosters = fetcher(f"{league_url}/rosters")
    snapshot["data/league.json"] = league
    snapshot["data/users.json"] = users
    snapshot["data/rosters.json"] = rosters
    snapshot["data/traded_picks.json"] = fetcher(f"{league_url}/traded_picks")
    snapshot["data/nfl_state.json"] = fetcher(f"{API_BASE}/state/nfl")

    drafts = fetcher(f"{league_url}/drafts")
    snapshot["data/drafts/index.json"] = drafts
    all_draft_picks: list[dict[str, Any]] = []
    for draft in drafts:
        draft_id = str(draft["draft_id"])
        picks = fetcher(f"{API_BASE}/draft/{draft_id}/picks")
        snapshot[f"data/drafts/{draft_id}_picks.json"] = picks
        all_draft_picks.extend(picks)

    transactions_by_id: dict[str, JsonValue] = {}
    for week in TRANSACTION_WEEKS:
        transactions = fetcher(f"{league_url}/transactions/{week}")
        snapshot[f"data/transactions/by_week/week_{week:02d}.json"] = transactions
        for transaction in transactions:
            transaction_id = str(transaction.get("transaction_id", ""))
            if transaction_id:
                transactions_by_id[transaction_id] = transaction

    all_transactions = sorted(
        transactions_by_id.values(),
        key=lambda item: (int(item.get("created") or 0), str(item.get("transaction_id") or "")),
        reverse=True,
    )
    snapshot["data/transactions/all.json"] = all_transactions

    active_player_map = player_map
    if refresh_players:
        full_player_map = fetcher(f"{API_BASE}/players/nfl")
        if not isinstance(full_player_map, dict):
            raise SyncError("Sleeper player database must be a JSON object")
        referenced = referenced_player_ids(rosters, all_draft_picks, all_transactions)
        active_player_map = {
            player_id: full_player_map[player_id]
            for player_id in sorted(referenced)
            if player_id in full_player_map
        }
        snapshot["data/players.json"] = active_player_map

    if active_player_map is not None:
        snapshot["data/rosters_resolved.json"] = resolve_rosters(
            league, rosters, users, active_player_map
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
    parser.add_argument(
        "--refresh-players",
        action="store_true",
        help="Refresh Sleeper's NFL player database and commit only league-referenced players.",
    )
    args = parser.parse_args(argv)

    root = args.root.resolve()
    config = load_config(root / "config.json")
    league_id = str(args.league_id or config["league_id"])
    players_path = root / "data" / "players.json"

    try:
        cached_players = load_player_map(players_path)
        refresh_players = args.refresh_players or cached_players is None
        snapshot = collect_snapshot(
            league_id,
            player_map=cached_players,
            refresh_players=refresh_players,
        )
        changed = write_snapshot(root, snapshot)
    except (SyncError, KeyError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    status = "updated" if changed else "unchanged"
    player_status = "refreshed" if refresh_players else "cached"
    print(
        f"Sleeper league {league_id}: {status} ({len(snapshot)} files tracked; players {player_status})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
