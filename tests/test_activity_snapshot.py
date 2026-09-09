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


if __name__ == '__main__':
    unittest.main()
