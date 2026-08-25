import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "sync" / "sync_sleeper.py"


def load_sync_module(testcase: unittest.TestCase):
    testcase.assertTrue(SCRIPT.exists(), "sync/sync_sleeper.py must exist")
    spec = importlib.util.spec_from_file_location("sync_sleeper", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SyncSleeperTests(unittest.TestCase):
    def test_collect_snapshot_fetches_core_draft_and_transaction_data(self):
        module = load_sync_module(self)
        self.assertTrue(hasattr(module, "collect_snapshot"), "collect_snapshot must exist")

        league_id = "1389332241724764160"
        calls = []

        def fake_fetch(url):
            calls.append(url)
            if url.endswith(f"/league/{league_id}"):
                return {"league_id": league_id, "name": "Cloud Dynasty", "season": "2026"}
            if url.endswith(f"/league/{league_id}/users"):
                return [{"user_id": "u1", "display_name": "Owner One"}]
            if url.endswith(f"/league/{league_id}/rosters"):
                return [{"roster_id": 1, "owner_id": "u1", "taxi": ["p2"], "players": ["p1", "p2"]}]
            if url.endswith(f"/league/{league_id}/traded_picks"):
                return [{"season": "2027", "round": 1, "roster_id": 1, "owner_id": 2}]
            if url.endswith(f"/league/{league_id}/drafts"):
                return [{"draft_id": "d1", "season": "2026"}]
            if url.endswith("/draft/d1/picks"):
                return [{"draft_id": "d1", "pick_no": 1, "player_id": "p1"}]
            if url.endswith("/state/nfl"):
                return {"season": "2026", "week": 1}
            if "/transactions/" in url:
                week = int(url.rsplit("/", 1)[1])
                if week == 1:
                    return [{"transaction_id": "t1", "created": 20, "type": "trade"}]
                if week == 2:
                    return [
                        {"transaction_id": "t1", "created": 20, "type": "trade"},
                        {"transaction_id": "t2", "created": 10, "type": "waiver"},
                    ]
                return []
            raise AssertionError(f"unexpected URL: {url}")

        snapshot = module.collect_snapshot(league_id, fake_fetch)

        self.assertEqual(snapshot["data/league.json"]["name"], "Cloud Dynasty")
        self.assertEqual(snapshot["data/rosters.json"][0]["taxi"], ["p2"])
        self.assertEqual(snapshot["data/drafts/index.json"][0]["draft_id"], "d1")
        self.assertEqual(snapshot["data/drafts/d1_picks.json"][0]["pick_no"], 1)
        self.assertEqual(
            [t["transaction_id"] for t in snapshot["data/transactions/all.json"]],
            ["t1", "t2"],
        )
        self.assertEqual(len([c for c in calls if "/transactions/" in c]), 18)
        self.assertIn("data/transactions/by_week/week_18.json", snapshot)

    def test_write_snapshot_is_deterministic_and_does_not_rewrite_unchanged_json(self):
        module = load_sync_module(self)
        self.assertTrue(hasattr(module, "write_snapshot"), "write_snapshot must exist")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = {"data/league.json": {"z": 2, "a": 1}}
            changed_first = module.write_snapshot(root, snapshot)
            first_bytes = (root / "data/league.json").read_bytes()
            changed_second = module.write_snapshot(root, snapshot)
            second_bytes = (root / "data/league.json").read_bytes()

            self.assertTrue(changed_first)
            self.assertFalse(changed_second)
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(json.loads(second_bytes), {"a": 1, "z": 2})
            self.assertTrue(second_bytes.endswith(b"\n"))

    def test_write_snapshot_removes_stale_generated_draft_and_transaction_files(self):
        module = load_sync_module(self)
        self.assertTrue(hasattr(module, "write_snapshot"), "write_snapshot must exist")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale_draft = root / "data/drafts/old_picks.json"
            stale_week = root / "data/transactions/by_week/week_99.json"
            unrelated = root / "data/keep-me.txt"
            stale_draft.parent.mkdir(parents=True)
            stale_week.parent.mkdir(parents=True)
            stale_draft.write_text("[]\n")
            stale_week.write_text("[]\n")
            unrelated.write_text("keep")

            module.write_snapshot(
                root,
                {
                    "data/drafts/index.json": [],
                    "data/transactions/all.json": [],
                    "data/transactions/by_week/week_01.json": [],
                },
            )

            self.assertFalse(stale_draft.exists())
            self.assertFalse(stale_week.exists())
            self.assertTrue(unrelated.exists())

    def test_load_config_returns_cloud_dynasty_league_id(self):
        module = load_sync_module(self)
        self.assertTrue(hasattr(module, "load_config"), "load_config must exist")
        config_path = ROOT / "config.json"
        self.assertTrue(config_path.exists(), "config.json must exist")
        self.assertEqual(module.load_config(config_path)["league_id"], "1389332241724764160")

    def test_resolve_rosters_adds_owner_names_slots_and_sections(self):
        module = load_sync_module(self)
        self.assertTrue(hasattr(module, "resolve_rosters"), "resolve_rosters must exist")

        league = {
            "league_id": "1389332241724764160",
            "roster_positions": ["QB", "RB", "WR", "SUPER_FLEX", "DEF", "BN", "BN"],
        }
        users = [
            {
                "user_id": "u1",
                "username": "ownerone",
                "display_name": "Owner One",
                "metadata": {"team_name": "The Testers"},
            }
        ]
        rosters = [
            {
                "roster_id": 1,
                "owner_id": "u1",
                "players": ["p1", "p2", "p3", "p4", "TB"],
                "starters": ["p1", "p2", "p3", "TB", "0"],
                "reserve": ["p4"],
                "taxi": ["p3"],
                "settings": {"wins": 0},
            }
        ]
        players = {
            "p1": {"player_id": "p1", "first_name": "Quarter", "last_name": "Back", "position": "QB", "team": "BUF"},
            "p2": {"player_id": "p2", "full_name": "Runner One", "position": "RB", "team": "DET"},
            "p3": {"player_id": "p3", "first_name": "Wide", "last_name": "Receiver", "position": "WR", "team": "PHI"},
            "p4": {"player_id": "p4", "full_name": "Injured Guy", "position": "TE", "team": "KC"},
        }

        resolved = module.resolve_rosters(league, rosters, users, players)

        self.assertEqual(resolved["starter_slots"], ["QB", "RB", "WR", "SUPER_FLEX", "DEF"])
        roster = resolved["rosters"][0]
        self.assertEqual(roster["owner"]["display_name"], "Owner One")
        self.assertEqual(roster["owner"]["team_name"], "The Testers")
        self.assertEqual(roster["starters"][0]["name"], "Quarter Back")
        self.assertEqual(roster["starters"][0]["starter_slot"], "QB")
        self.assertEqual(roster["starters"][3]["name"], "TB D/ST")
        self.assertEqual(roster["starters"][3]["starter_slot"], "SUPER_FLEX")
        self.assertEqual(roster["starters"][4]["name"], "EMPTY")
        self.assertEqual([p["player_id"] for p in roster["taxi"]], ["p3"])
        self.assertEqual([p["player_id"] for p in roster["reserve"]], ["p4"])
        self.assertEqual([p["player_id"] for p in roster["bench"]], [])

    def test_collect_snapshot_refreshes_only_referenced_players_and_writes_resolved_rosters(self):
        module = load_sync_module(self)
        league_id = "1389332241724764160"

        def fake_fetch(url):
            if url.endswith(f"/league/{league_id}"):
                return {
                    "league_id": league_id,
                    "name": "Cloud Dynasty",
                    "roster_positions": ["QB", "SUPER_FLEX", "BN"],
                }
            if url.endswith(f"/league/{league_id}/users"):
                return [{"user_id": "u1", "display_name": "Owner One", "metadata": {}}]
            if url.endswith(f"/league/{league_id}/rosters"):
                return [{"roster_id": 1, "owner_id": "u1", "players": ["p1", "p2"], "starters": ["p1", "p2"], "reserve": None, "taxi": None}]
            if url.endswith(f"/league/{league_id}/traded_picks"):
                return []
            if url.endswith(f"/league/{league_id}/drafts"):
                return [{"draft_id": "d1"}]
            if url.endswith("/draft/d1/picks"):
                return [{"draft_id": "d1", "player_id": "p3"}]
            if url.endswith("/state/nfl"):
                return {"season": "2026"}
            if url.endswith("/players/nfl"):
                return {
                    "p1": {"player_id": "p1", "full_name": "Player One", "position": "QB"},
                    "p2": {"player_id": "p2", "full_name": "Player Two", "position": "RB"},
                    "p3": {"player_id": "p3", "full_name": "Player Three", "position": "WR"},
                    "unused": {"player_id": "unused", "full_name": "Unused Player", "position": "TE"},
                }
            if "/transactions/" in url:
                week = int(url.rsplit("/", 1)[1])
                if week == 1:
                    return [{"transaction_id": "t1", "created": 1, "adds": {"p4": 1}, "drops": None}]
                return []
            raise AssertionError(f"unexpected URL: {url}")

        snapshot = module.collect_snapshot(league_id, fake_fetch, refresh_players=True)

        self.assertEqual(set(snapshot["data/players.json"]), {"p1", "p2", "p3"})
        self.assertNotIn("unused", snapshot["data/players.json"])
        self.assertIn("data/rosters_resolved.json", snapshot)
        self.assertEqual(snapshot["data/rosters_resolved.json"]["rosters"][0]["starters"][0]["name"], "Player One")

    def test_collect_snapshot_uses_cached_player_map_without_fetching_full_player_database(self):
        module = load_sync_module(self)
        league_id = "1389332241724764160"
        calls = []

        def fake_fetch(url):
            calls.append(url)
            if url.endswith(f"/league/{league_id}"):
                return {"league_id": league_id, "roster_positions": ["QB", "BN"]}
            if url.endswith(f"/league/{league_id}/users"):
                return []
            if url.endswith(f"/league/{league_id}/rosters"):
                return [{"roster_id": 1, "owner_id": None, "players": ["p1"], "starters": ["p1"], "reserve": None, "taxi": None}]
            if url.endswith(f"/league/{league_id}/traded_picks"):
                return []
            if url.endswith(f"/league/{league_id}/drafts"):
                return []
            if url.endswith("/state/nfl"):
                return {"season": "2026"}
            if "/transactions/" in url:
                return []
            if url.endswith("/players/nfl"):
                raise AssertionError("full player database should not be fetched on normal 6-hour sync")
            raise AssertionError(f"unexpected URL: {url}")

        cached = {"p1": {"player_id": "p1", "full_name": "Cached Player", "position": "QB"}}
        snapshot = module.collect_snapshot(league_id, fake_fetch, player_map=cached, refresh_players=False)

        self.assertNotIn("data/players.json", snapshot)
        self.assertEqual(snapshot["data/rosters_resolved.json"]["rosters"][0]["starters"][0]["name"], "Cached Player")
        self.assertFalse(any(url.endswith("/players/nfl") for url in calls))


if __name__ == "__main__":
    unittest.main()
