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


if __name__ == "__main__":
    unittest.main()
