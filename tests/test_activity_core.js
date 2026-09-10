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
assert.ok(snapshot.includes('CURRENT ROSTERS'));

console.log('activity_core tests passed');

const ownership = core.buildCurrentOwnership([
  {roster_id: 1, players: ['100'], taxi: ['300'], reserve: ['400'], starters: ['500']},
  {roster_id: 2, players: ['200']},
]);
assert.equal(ownership['100'], 1);
assert.equal(ownership['300'], 1, 'taxi players must count as rostered');
assert.equal(ownership['400'], 1, 'reserve players must count as rostered');
assert.equal(ownership['500'], 1, 'starter-only players must count as rostered');

const sameOwnerDrop = core.normalizeTransaction({
  transaction_id: 'same-owner-drop', type: 'free_agent', status: 'complete', created: 2000000000000,
  roster_ids: [1], drops: {'100': 1}, adds: null,
}, teams, players, {'100': 1});
assert.equal(sameOwnerDrop.drop_checks[0].availability, 'rostered_same');
assert.ok(sameOwnerDrop.summary.includes('CURRENTLY STILL ON HTTFFT'));

const otherOwnerDrop = core.normalizeTransaction({
  transaction_id: 'other-owner-drop', type: 'free_agent', status: 'complete', created: 2000000000000,
  roster_ids: [1], drops: {'100': 1}, adds: null,
}, teams, players, {'100': 2});
assert.equal(otherOwnerDrop.drop_checks[0].availability, 'rostered_other');
assert.ok(otherOwnerDrop.summary.includes('CURRENTLY ROSTERED BY Millertime'));

const availableDrop = core.normalizeTransaction({
  transaction_id: 'available-drop', type: 'free_agent', status: 'complete', created: 2000000000000,
  roster_ids: [1], drops: {'100': 1}, adds: null,
}, teams, players, {});
assert.equal(availableDrop.drop_checks[0].availability, 'unrostered_api');
assert.ok(availableDrop.summary.includes('UNROSTERED PER PUBLIC API — VERIFY IN SLEEPER'));
assert.ok(!availableDrop.summary.includes('CONFIRMED AVAILABLE'));

const reconciledSnapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League', hours: 24, refreshedIso: '2026-09-09T00:00:00Z',
  transactions: [sameOwnerDrop, availableDrop], rosterSummaries: [],
});
assert.ok(reconciledSnapshot.includes('Unrostered per public API — verify in Sleeper:'));
assert.ok(!reconciledSnapshot.includes('Confirmed available from drop events:'));
assert.ok(reconciledSnapshot.includes('Ownership mismatches / re-rostered players:'));

// Full Sleeper feed normalization / classification
const rawChat = {
  message_id: 'm1',
  created: 2_000_000_000_000,
  author_id: 'u1',
  author_display_name: 'BrandonBroncos',
  author_is_bot: false,
  text: "I'll trade with anyone",
  text_map: null,
  attachment: null,
  reactions: [{reaction: 'thumbsup', count: 1}],
  pinned: false,
};

const normalizedChat = core.normalizeFeedMessage(rawChat);
assert.equal(normalizedChat.message_id, 'm1');
assert.equal(normalizedChat.author_name, 'BrandonBroncos');
assert.equal(normalizedChat.text, "I'll trade with anyone");
assert.equal(normalizedChat.kind, 'trade_interest');
assert.equal(normalizedChat.created_ms, 2_000_000_000_000);

const routineSystem = core.normalizeFeedMessage({
  message_id: 'm2', created: 2_000_000_000_100,
  author_is_bot: true,
  text: 'PhastEddy made a free agent move.',
});
assert.equal(routineSystem.kind, 'system');

const tradeBlock = core.normalizeFeedMessage({
  message_id: 'm3', created: 2_000_000_000_200,
  author_is_bot: true,
  text: 'THB1284 put a player on the trade block: J. Downs (WR - IND)',
});
assert.equal(tradeBlock.kind, 'trade_block');

const recentFeed = core.filterRecentFeed([
  rawChat,
  {...rawChat, message_id: 'old-chat', created: 2_000_000_000_000 - 90_000_000},
], 2_000_000_000_000, 24);
assert.deepStrictEqual(recentFeed.map(x => x.message_id), ['m1']);

const signals = core.extractMarketSignals([
  normalizedChat,
  routineSystem,
  tradeBlock,
  core.normalizeFeedMessage({
    message_id: 'm4', created: 2_000_000_000_300,
    author_display_name: 'THB1284', author_is_bot: false,
    text: 'Solid WR available. Send me future draft picks for Sutton and Thomas Jr!',
  }),
]);
assert.equal(signals.length, 3);
assert.deepStrictEqual(signals.map(x => x.signal_type), ['trade_interest', 'trade_block', 'trade_interest']);
assert.ok(!signals.some(x => x.source_text.includes('free agent move')));

const rosterView = core.buildRosterView({
  roster_id: 1,
  players: ['100', '200', '300', '400'],
  taxi: ['300'],
  reserve: ['400'],
  starters: ['100'],
}, 'HTTFFT', {
  '100': {full_name: 'Lamar Jackson', position: 'QB', team: 'BAL'},
  '200': {full_name: 'Nico Collins', position: 'WR', team: 'HOU'},
  '300': {full_name: 'Fernando Mendoza', position: 'QB', team: 'LV'},
  '400': {full_name: 'Injured Player', position: 'RB', team: 'TEST'},
});
assert.deepStrictEqual(rosterView.active.map(x => x.player_id), ['100', '200']);
assert.deepStrictEqual(rosterView.taxi.map(x => x.player_id), ['300']);
assert.deepStrictEqual(rosterView.reserve.map(x => x.player_id), ['400']);
const rosterText = core.formatRosterView(rosterView);
assert.ok(rosterText.includes('Active:'));
assert.ok(rosterText.includes('Taxi: Fernando Mendoza'));
assert.ok(rosterText.includes('Reserve / IR: Injured Player'));

const fullSnapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League',
  hours: 24,
  refreshedIso: '2026-09-09T01:00:00Z',
  transactions: [item],
  feedMessages: [normalizedChat, routineSystem, tradeBlock],
  marketSignals: core.extractMarketSignals([normalizedChat, routineSystem, tradeBlock]),
  rosterViews: [rosterView],
  feedStatus: 'connected',
});
assert.ok(fullSnapshot.includes('MARKET INTELLIGENCE'));
assert.ok(fullSnapshot.includes("BrandonBroncos — I'll trade with anyone"));
assert.ok(fullSnapshot.includes('COMPLETED TRANSACTIONS'));
assert.ok(fullSnapshot.includes('Daniel Jones'));
assert.ok(fullSnapshot.includes('FULL SLEEPER FEED'));
assert.ok(fullSnapshot.includes('PhastEddy made a free agent move.'));
assert.ok(fullSnapshot.includes('CURRENT ROSTERS'));
assert.ok(fullSnapshot.includes('Taxi: Fernando Mendoza'));
assert.ok(fullSnapshot.indexOf('MARKET INTELLIGENCE') < fullSnapshot.indexOf('COMPLETED TRANSACTIONS'));
assert.ok(fullSnapshot.indexOf('COMPLETED TRANSACTIONS') < fullSnapshot.indexOf('FULL SLEEPER FEED'));
assert.ok(!fullSnapshot.includes('super-secret-token'));

const publicOnlySnapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League', hours: 24, refreshedIso: 'x',
  transactions: [item], feedMessages: [], marketSignals: [], rosterViews: [], feedStatus: 'disconnected',
});
assert.ok(publicOnlySnapshot.includes('FULL SLEEPER FEED'));
assert.ok(publicOnlySnapshot.includes('Sleeper feed not connected'));
assert.ok(publicOnlySnapshot.includes('Daniel Jones'));

const malformed = core.normalizeFeedMessage({message_id: 'odd', created: 2_000_000_000_000, text_map: {a: null, b: 17}});
assert.equal(malformed.message_id, 'odd');
assert.doesNotThrow(() => core.feedDisplayText(malformed));
assert.ok(core.feedDisplayText(malformed).includes('17'));

const secret = 'THIS-MUST-NEVER-LEAK-123';
const sanitizedMessage = core.normalizeFeedMessage({
  message_id: 's1', created: 2_000_000_000_000,
  text: '', text_map: {authorization: secret, nested: {cookie: secret, safe: 'visible'}},
  attachment: {token: secret, label: 'attachment-visible'},
});
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedMessage.text_map, 'authorization'));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedMessage.text_map.nested, 'cookie'));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitizedMessage.attachment, 'token'));
assert.equal(sanitizedMessage.raw, null);

const noSecretSnapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League', hours: 24, refreshedIso: 'x',
  transactions: [],
  feedMessages: [sanitizedMessage],
  marketSignals: [], rosterViews: [], feedStatus: 'connected',
});
assert.ok(!noSecretSnapshot.includes(secret));
assert.ok(noSecretSnapshot.includes('visible'));
assert.ok(noSecretSnapshot.includes('attachment-visible') || core.feedDisplayText(sanitizedMessage).includes('visible'));

const systemWithPlayerAttachment = core.normalizeFeedMessage({
  message_id: 'system-player', created: 2_000_000_000_000,
  author_is_bot: true,
  text: 'JROC1379 made a free agent move.',
  attachment: {player_name: 'Zach Charbonnet', position: 'RB', team: 'SEA'},
});
assert.ok(core.feedDisplayText(systemWithPlayerAttachment).includes('JROC1379 made a free agent move.'));
assert.ok(core.feedDisplayText(systemWithPlayerAttachment).includes('Zach Charbonnet'));

const preDraftTradeSignal = core.normalizeFeedMessage({
  message_id: 'predraft', created: 2_000_000_000_000,
  author_display_name: 'THB1284', author_is_bot: false,
  text: 'lets get some pre draft trades goin',
});
assert.equal(preDraftTradeSignal.kind, 'trade_interest');
