#!/usr/bin/env python3
"""Build a compact Cloud Dynasty activity snapshot from Sleeper transactions."""

from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

API = "https://api.sleeper.app/v1"
ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEAGUE_ID = "1389332241724764160"


def ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def pick_label(pick: dict[str, Any]) -> str:
    return f"{pick.get('season', '?')} {ordinal(int(pick.get('round', 0) or 0))}"


def _player_name(player_id: str, players: dict[str, Any]) -> str:
    value = players.get(str(player_id))
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("full_name") or " ".join(
            p for p in [value.get("first_name"), value.get("last_name")] if p
        ) or str(player_id)
    return str(player_id)


def _team(roster_id: Any, teams: dict[int, str]) -> str:
    try:
        rid = int(roster_id)
    except (TypeError, ValueError):
        return f"Roster {roster_id}"
    return teams.get(rid, f"Roster {rid}")


def transaction_time_ms(tx: dict[str, Any]) -> int:
    return int(tx.get("created") or tx.get("status_updated") or 0)


def filter_recent(transactions: list[dict[str, Any]], *, now_ms: int, hours: int = 24) -> list[dict[str, Any]]:
    cutoff = now_ms - hours * 60 * 60 * 1000
    result = [
        tx for tx in transactions
        if tx.get("status") == "complete" and transaction_time_ms(tx) >= cutoff
    ]
    return sorted(result, key=transaction_time_ms, reverse=True)


def build_current_ownership(rosters: list[dict[str, Any]]) -> dict[str, int]:
    ownership: dict[str, int] = {}
    for roster in rosters:
        rid = int(roster["roster_id"])
        ids = set(str(x) for x in (roster.get("players") or []))
        ids.update(str(x) for x in (roster.get("taxi") or []))
        ids.update(str(x) for x in (roster.get("reserve") or []))
        for player_id in ids:
            ownership[player_id] = rid
    return ownership


def normalize_transaction(
    tx: dict[str, Any],
    teams: dict[int, str],
    players: dict[str, Any],
    current_ownership: dict[str, int] | None = None,
) -> dict[str, Any]:
    tx_type = str(tx.get("type") or "transaction")
    stamp_ms = transaction_time_ms(tx)
    stamp = datetime.fromtimestamp(stamp_ms / 1000, tz=timezone.utc).astimezone(ET) if stamp_ms else None

    adds = tx.get("adds") or {}
    drops = tx.get("drops") or {}
    picks = tx.get("draft_picks") or []
    budgets = tx.get("waiver_budget") or []
    settings = tx.get("settings") or {}
    roster_ids = [int(x) for x in (tx.get("roster_ids") or [])]
    current_ownership = current_ownership or {}
    drop_checks: list[dict[str, Any]] = []

    if tx_type == "trade":
        incoming: dict[int, list[str]] = {rid: [] for rid in roster_ids}
        for player_id, rid in adds.items():
            incoming.setdefault(int(rid), []).append(_player_name(str(player_id), players))
        for pick in picks:
            rid = int(pick.get("owner_id"))
            incoming.setdefault(rid, []).append(pick_label(pick))
        for budget in budgets:
            rid = int(budget.get("receiver"))
            incoming.setdefault(rid, []).append(f"${int(budget.get('amount', 0))} FAAB")

        parts = []
        for rid in roster_ids:
            assets = incoming.get(rid, [])
            if assets:
                parts.append(f"{_team(rid, teams)} receives: {', '.join(assets)}")
        summary = "; ".join(parts) if parts else f"Trade between {', '.join(_team(x, teams) for x in roster_ids)}"
    else:
        rid = roster_ids[0] if roster_ids else None
        team_name = _team(rid, teams) if rid is not None else "Unknown team"
        added = [_player_name(str(pid), players) for pid in adds]
        pieces = [team_name]
        if added:
            pieces.append("adds " + ", ".join(added))
        for pid in drops:
            player_id = str(pid)
            player = _player_name(player_id, players)
            current_owner = current_ownership.get(player_id)
            if current_owner is None:
                check = {
                    "player_id": player_id,
                    "player_name": player,
                    "availability": "available",
                    "current_owner_roster_id": None,
                    "current_owner_name": None,
                    "label": f"{player} [CONFIRMED AVAILABLE]",
                }
            elif rid is not None and int(current_owner) == int(rid):
                owner = _team(current_owner, teams)
                check = {
                    "player_id": player_id,
                    "player_name": player,
                    "availability": "rostered_same",
                    "current_owner_roster_id": int(current_owner),
                    "current_owner_name": owner,
                    "label": f"{player} [CURRENTLY STILL ON {owner} ⚠️]",
                }
            else:
                owner = _team(current_owner, teams)
                check = {
                    "player_id": player_id,
                    "player_name": player,
                    "availability": "rostered_other",
                    "current_owner_roster_id": int(current_owner),
                    "current_owner_name": owner,
                    "label": f"{player} [CURRENTLY ROSTERED BY {owner} ⚠️]",
                }
            drop_checks.append(check)
        if drop_checks:
            pieces.append("drop event: " + ", ".join(x["label"] for x in drop_checks))
        bid = settings.get("waiver_bid")
        if bid is not None:
            pieces.append(f"for ${int(bid)} FAAB")
        summary = " — ".join(pieces)

    return {
        "transaction_id": tx.get("transaction_id"),
        "type": tx_type,
        "created_ms": stamp_ms,
        "created_et": stamp.isoformat() if stamp else None,
        "roster_ids": roster_ids,
        "summary": summary,
        "drop_checks": drop_checks,
        "raw": tx,
    }


def fetch_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "cloud-dynasty-activity/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def load_league_id() -> str:
    env = os.environ.get("SLEEPER_LEAGUE_ID")
    if env:
        return env
    config = ROOT / "config.json"
    if config.exists():
        try:
            return str(json.loads(config.read_text(encoding="utf-8"))["league_id"])
        except Exception:
            pass
    return DEFAULT_LEAGUE_ID


def load_players() -> dict[str, Any]:
    path = ROOT / "data" / "players.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload
    return {}


def build_teams(users: list[dict[str, Any]], rosters: list[dict[str, Any]]) -> dict[int, str]:
    users_by_id = {str(u.get("user_id")): u for u in users}
    teams: dict[int, str] = {}
    for roster in rosters:
        rid = int(roster["roster_id"])
        user = users_by_id.get(str(roster.get("owner_id")), {})
        metadata = user.get("metadata") or {}
        teams[rid] = metadata.get("team_name") or user.get("display_name") or user.get("username") or f"Roster {rid}"
    return teams


def candidate_weeks(state: dict[str, Any]) -> list[int]:
    week = int(state.get("week") or 1)
    leg = int(state.get("leg") or week)
    return sorted({0, 1, week, leg, max(1, week - 1), max(1, leg - 1)})


def main() -> None:
    league_id = load_league_id()
    league = fetch_json(f"{API}/league/{league_id}")
    users = fetch_json(f"{API}/league/{league_id}/users")
    rosters = fetch_json(f"{API}/league/{league_id}/rosters")
    state = fetch_json(f"{API}/state/nfl")
    teams = build_teams(users, rosters)
    current_ownership = build_current_ownership(rosters)
    players = load_players()

    by_id: dict[str, dict[str, Any]] = {}
    for week in candidate_weeks(state):
        try:
            txs = fetch_json(f"{API}/league/{league_id}/transactions/{week}")
        except Exception:
            continue
        for tx in txs or []:
            tx_id = str(tx.get("transaction_id") or f"{week}:{transaction_time_ms(tx)}:{len(by_id)}")
            by_id[tx_id] = tx

    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    recent = filter_recent(list(by_id.values()), now_ms=now_ms, hours=24)
    normalized = [normalize_transaction(tx, teams, players, current_ownership) for tx in recent]
    involved = sorted({rid for item in normalized for rid in item["roster_ids"]})

    output = {
        "league_id": league_id,
        "league_name": league.get("name"),
        "window_hours": 24,
        "generated_at_utc": datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat(),
        "generated_at_et": datetime.now(tz=ET).replace(microsecond=0).isoformat(),
        "transaction_count": len(normalized),
        "involved_teams": [{"roster_id": rid, "team": teams.get(rid, f"Roster {rid}")} for rid in involved],
        "transactions": normalized,
    }

    out = ROOT / "data" / "activity_snapshot.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)} with {len(normalized)} transaction(s).")


if __name__ == "__main__":
    main()
