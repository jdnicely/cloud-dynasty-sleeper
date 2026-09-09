const assert = require('assert');
const fs = require('fs');
const path = require('path');

const corePath = path.join(__dirname, '..', 'activity', 'activity_core.js');
assert.ok(fs.existsSync(corePath), 'activity/activity_core.js must exist');
const core = require(corePath);

const teams = {1: 'HTTFFT', 2: 'Millertime'};
const players = {
  '100': {full_name: 'Daniel Jones', position: 'QB', team: 'IND'},
  '200': {full_name: 'Test Receiver', position: 'WR', team: 'NYJ'},
};

const trade = {
  type: 'trade', status: 'complete', created: 2000000000000,
  roster_ids: [1, 2],
  adds: {'100': 2, '200': 1},
  draft_picks: [{season: '2027', round: 1, roster_id: 2, previous_owner_id: 2, owner_id: 1}],
  waiver_budget: [{sender: 1, receiver: 2, amount: 15}],
};
const item = core.normalizeTransaction(trade, teams, players);
assert.equal(item.type, 'trade');
assert.ok(item.summary.includes('Daniel Jones'));
assert.ok(item.summary.includes('2027 1st'));
assert.ok(item.summary.includes('$15 FAAB'));

const recent = core.filterRecent([
  {transaction_id: 'fresh', status: 'complete', created: 2000000000000 - 1000},
  {transaction_id: 'old', status: 'complete', created: 2000000000000 - 90000000},
  {transaction_id: 'pending', status: 'pending', created: 2000000000000 - 1000},
], 2000000000000, 24);
assert.deepStrictEqual(recent.map(x => x.transaction_id), ['fresh']);

const snapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League',
  hours: 24,
  refreshedIso: '2026-09-08T20:00:00-04:00',
  transactions: [item],
  rosterSummaries: ['HTTFFT — QB: Lamar Jackson; WR: Nico Collins'],
});
assert.ok(snapshot.includes('CLOUD DYNASTY LEAGUE ACTIVITY SNAPSHOT'));
assert.ok(snapshot.includes('Daniel Jones'));
assert.ok(snapshot.includes('Current involved rosters'));

console.log('activity_core tests passed');
