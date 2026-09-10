import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).parents[1] / 'sync' / 'activity_snapshot.py'


class ActivitySnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not MODULE_PATH.exists():
            raise AssertionError('sync/activity_snapshot.py must exist')
        spec = importlib.util.spec_from_file_location('activity_snapshot', MODULE_PATH)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def test_trade_formats_players_picks_and_faab(self):
        tx = {
            'type': 'trade',
            'status': 'complete',
            'created': 1788912000000,
            'roster_ids': [1, 2],
            'adds': {'100': 2, '200': 1},
            'drops': None,
            'draft_picks': [
                {'season': '2027', 'round': 1, 'roster_id': 2, 'previous_owner_id': 2, 'owner_id': 1}
            ],
            'waiver_budget': [{'sender': 1, 'receiver': 2, 'amount': 15}],
        }
        teams = {1: 'HTTFFT', 2: 'Millertime'}
        players = {'100': 'Daniel Jones', '200': 'Test Receiver'}

        item = self.mod.normalize_transaction(tx, teams, players)

        self.assertEqual(item['type'], 'trade')
        self.assertIn('Daniel Jones', item['summary'])
        self.assertIn('2027 1st', item['summary'])
        self.assertIn('$15 FAAB', item['summary'])
        self.assertIn('HTTFFT', item['summary'])
        self.assertIn('Millertime', item['summary'])

    def test_waiver_includes_bid_and_drop(self):
        tx = {
            'type': 'waiver',
            'status': 'complete',
            'created': 1788912000000,
            'roster_ids': [1],
            'adds': {'300': 1},
            'drops': {'400': 1},
            'settings': {'waiver_bid': 23},
            'draft_picks': [],
            'waiver_budget': [],
        }
        teams = {1: 'HTTFFT'}
        players = {'300': 'Added Player', '400': 'Dropped Player'}

        item = self.mod.normalize_transaction(tx, teams, players)

        self.assertIn('Added Player', item['summary'])
        self.assertIn('Dropped Player', item['summary'])
        self.assertIn('$23 FAAB', item['summary'])

    def test_filter_uses_created_or_status_updated_and_only_complete(self):
        now_ms = 2_000_000_000_000
        transactions = [
            {'transaction_id': 'fresh', 'status': 'complete', 'created': now_ms - 1000},
            {'transaction_id': 'old', 'status': 'complete', 'created': now_ms - 90_000_000},
            {'transaction_id': 'pending', 'status': 'pending', 'created': now_ms - 1000},
            {'transaction_id': 'status-only', 'status': 'complete', 'status_updated': now_ms - 2000},
        ]

        filtered = self.mod.filter_recent(transactions, now_ms=now_ms, hours=24)

        self.assertEqual([x['transaction_id'] for x in filtered], ['fresh', 'status-only'])

    def test_current_ownership_includes_players_taxi_and_reserve(self):
        rosters = [
            {'roster_id': 1, 'players': ['100'], 'taxi': ['200'], 'reserve': ['300'], 'starters': ['500']},
            {'roster_id': 2, 'players': ['400']},
        ]
        ownership = self.mod.build_current_ownership(rosters)
        self.assertEqual(ownership['100'], 1)
        self.assertEqual(ownership['200'], 1)
        self.assertEqual(ownership['300'], 1)
        self.assertEqual(ownership['400'], 2)
        self.assertEqual(ownership['500'], 1)

    def test_drop_reconciliation_marks_same_roster_other_roster_and_available(self):
        teams = {1: 'Danger Zone', 2: 'goTribe Other'}
        players = {'100': 'Jordan Addison'}
        base = {
            'type': 'free_agent', 'status': 'complete', 'created': 1788912000000,
            'roster_ids': [1], 'adds': None, 'drops': {'100': 1}, 'draft_picks': [], 'waiver_budget': [],
        }

        same = self.mod.normalize_transaction(base, teams, players, {'100': 1})
        self.assertEqual(same['drop_checks'][0]['availability'], 'rostered_same')
        self.assertIn('CURRENTLY STILL ON Danger Zone', same['summary'])

        other = self.mod.normalize_transaction(base, teams, players, {'100': 2})
        self.assertEqual(other['drop_checks'][0]['availability'], 'rostered_other')
        self.assertIn('CURRENTLY ROSTERED BY goTribe Other', other['summary'])

        available = self.mod.normalize_transaction(base, teams, players, {})
        self.assertEqual(available['drop_checks'][0]['availability'], 'unrostered_api')
        self.assertIn('UNROSTERED PER PUBLIC API — VERIFY IN SLEEPER', available['summary'])
        self.assertNotIn('CONFIRMED AVAILABLE', available['summary'])


    def test_archival_script_remains_public_api_only(self):
        source = MODULE_PATH.read_text(encoding='utf-8')
        self.assertNotIn('SLEEPER_TOKEN', source)
        self.assertNotIn('sleeper.app/graphql', source)
        self.assertNotIn('sleeper.com/graphql', source)
        self.assertNotIn('authorization', source.lower())



if __name__ == '__main__':
    unittest.main()
