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
assert.equal(core.feedDisplayText(systemWithPlayerAttachment), 'JROC1379 made a free agent move.');
const enrichedSystemWithPlayer = core.enrichFeedMessages([systemWithPlayerAttachment], {}, {
  '9753': {full_name: 'Zach Charbonnet', position: 'RB', team: 'SEA'},
});
assert.ok(enrichedSystemWithPlayer[0].display_text.includes('Zach Charbonnet'));

const preDraftTradeSignal = core.normalizeFeedMessage({
  message_id: 'predraft', created: 2_000_000_000_000,
  author_display_name: 'THB1284', author_is_bot: false,
  text: 'lets get some pre draft trades goin',
});
assert.equal(preDraftTradeSignal.kind, 'trade_interest');

// Regression: system-feed metadata must not leak into the human-readable feed.
const noisySystemMessage = core.normalizeFeedMessage({
  message_id: 'noisy-system',
  created: 2_000_000_000_400,
  author_display_name: 'sys',
  author_is_bot: true,
  text: 'msmiller2384 made a roster move: Dropped D. Mooney (WR - NYG)',
  text_map: ['flair'],
  attachment: {
    message_id: '1403569419971551232',
    player: {full_name: 'Darnell Mooney', player_id: '7090', position: 'WR', team: 'NYG'},
    status: 'complete',
    transaction_id: '6dcbee5f295974c3ea459f3aa1e3ba02',
    creator: 'msmiller2384',
    type: 'free_agent',
    parent_type: 'transactions',
  },
});
assert.equal(
  core.feedDisplayText(noisySystemMessage),
  'msmiller2384 made a roster move: Dropped D. Mooney (WR - NYG)',
);
assert.ok(!core.feedDisplayText(noisySystemMessage).includes('flair'));
assert.ok(!core.feedDisplayText(noisySystemMessage).includes('6dcbee5f295974c3ea459f3aa1e3ba02'));

// Regression: Sleeper usernames / handles should resolve to the league team name.
const feedIdentityMap = core.buildFeedIdentityMap([
  {user_id: 'u-miller', username: 'msmiller2384', display_name: 'msmiller2384', metadata: {team_name: 'Millertime'}},
  {user_id: 'u-eddy', username: 'eddy-login', display_name: 'PhastEddy', metadata: {team_name: 'PhastEddy'}},
], [
  {roster_id: 2, owner_id: 'u-miller'},
  {roster_id: 9, owner_id: 'u-eddy'},
], {'2': 'Millertime', '9': 'PhastEddy'});
assert.equal(core.resolveFeedManager(noisySystemMessage, feedIdentityMap), 'Millertime');

// Regression: if the public transaction endpoint misses a waiver event, recover it
// from the authenticated system feed; exact transaction IDs prevent duplicates.
const waiverFeedMessage = core.normalizeFeedMessage({
  message_id: 'waiver-system',
  created: 2_000_000_001_000,
  author_display_name: 'sys',
  author_is_bot: true,
  text: 'A player was claimed off waivers.',
  text_map: ['flair'],
  attachment: {
    transaction_id: '7572250c2fb084c434fed0e82229e183',
    creator: 'PhastEddy',
    type: 'waiver',
    settings: {waiver_bid: 0},
    players: [
      {full_name: 'Evan McPherson', player_id: '7839', position: 'K', team: 'CIN'},
      {full_name: 'Harrison Butker', player_id: '4227', position: 'K', team: 'KC'},
    ],
  },
});
const feedPlayers = {
  '7839': {full_name: 'Evan McPherson', position: 'K', team: 'CIN'},
  '4227': {full_name: 'Harrison Butker', position: 'K', team: 'KC'},
};
const enrichedWaiver = core.enrichFeedMessages([waiverFeedMessage], feedIdentityMap, feedPlayers);
assert.equal(enrichedWaiver[0].manager_name, 'PhastEddy');
assert.ok(enrichedWaiver[0].display_text.includes('Evan McPherson'));
assert.ok(enrichedWaiver[0].display_text.includes('Harrison Butker'));
assert.ok(!enrichedWaiver[0].display_text.includes('7572250c2fb084c434fed0e82229e183'));

const mergedMissingWaiver = core.mergeTransactionsWithFeed([], enrichedWaiver, {
  teams: {'9': 'PhastEddy'},
  players: feedPlayers,
  currentOwnership: {'7839': 9},
});
assert.equal(mergedMissingWaiver.length, 1);
assert.equal(mergedMissingWaiver[0].type, 'waiver');
assert.equal(mergedMissingWaiver[0].source, 'sleeper_feed');
assert.ok(mergedMissingWaiver[0].summary.includes('PhastEddy'));
assert.ok(mergedMissingWaiver[0].summary.includes('Evan McPherson'));
assert.ok(mergedMissingWaiver[0].summary.includes('Harrison Butker'));
assert.ok(mergedMissingWaiver[0].summary.includes('$0 FAAB'));

const samePublicWaiver = {
  transaction_id: '7572250c2fb084c434fed0e82229e183',
  type: 'waiver',
  created_ms: 2_000_000_001_000,
  roster_ids: [9],
  summary: 'PhastEddy — adds Evan McPherson — drop event: Harrison Butker — for $0 FAAB',
  drop_checks: [],
  raw: {},
};
const mergedDeduped = core.mergeTransactionsWithFeed([samePublicWaiver], enrichedWaiver, {
  teams: {'9': 'PhastEddy'},
  players: feedPlayers,
  currentOwnership: {'7839': 9},
});
assert.equal(mergedDeduped.length, 1);
assert.equal(mergedDeduped[0].source, undefined);

// Waiver-watch regression: a dropped skill-position player stays visible for 7 days
// while current ownership is unresolved, even when the main activity window is shorter.
const watchNow = 2_100_000_000_000;
const watchPlayers = {
  '900': {full_name: 'Jordan Addison', position: 'WR', team: 'MIN'},
  '901': {full_name: 'Josh Downs', position: 'WR', team: 'IND'},
  '902': {full_name: 'Example Kicker', position: 'K', team: 'TEST'},
  '903': {full_name: 'Old Receiver', position: 'WR', team: 'TEST'},
};
const watchTransactions = [
  {transaction_id: 'addison-drop', type: 'free_agent', status: 'complete', created: watchNow - 2 * 24 * 60 * 60 * 1000, roster_ids: [2], drops: {'900': 2}},
  {transaction_id: 'downs-drop', type: 'free_agent', status: 'complete', created: watchNow - 3 * 60 * 60 * 1000, roster_ids: [1], drops: {'901': 1}},
  {transaction_id: 'kicker-drop', type: 'free_agent', status: 'complete', created: watchNow - 2 * 60 * 60 * 1000, roster_ids: [1], drops: {'902': 1}},
  {transaction_id: 'old-drop', type: 'free_agent', status: 'complete', created: watchNow - 8 * 24 * 60 * 60 * 1000, roster_ids: [1], drops: {'903': 1}},
];
const openWatch = core.buildWaiverWatch(watchTransactions, watchPlayers, {}, teams, watchNow, 7);
assert.deepStrictEqual(openWatch.map(x => x.player_name), ['Josh Downs', 'Jordan Addison']);
assert.equal(openWatch[0].position, 'WR');
assert.ok(openWatch[0].label.includes('CURRENT OWNER UNRESOLVED — WATCH'));
assert.ok(openWatch[1].label.includes('dropped 2d ago'));
assert.ok(!openWatch.some(x => x.player_name === 'Example Kicker'), 'K/DST should not enter waiver watch');
assert.ok(!openWatch.some(x => x.player_name === 'Old Receiver'), 'drops older than 7 days should age out');

// Addison failure mode: once currently rostered, the player leaves OPEN WAIVER WATCH.
const claimedWatch = core.buildWaiverWatch(watchTransactions, watchPlayers, {'900': 1}, teams, watchNow, 7);
assert.ok(!claimedWatch.some(x => x.player_name === 'Jordan Addison'));
assert.ok(claimedWatch.some(x => x.player_name === 'Josh Downs'));

const waiverWatchSnapshot = core.buildSnapshotText({
  leagueName: 'Cloud Dynasty League',
  hours: 24,
  refreshedIso: '2026-09-10T21:00:00-04:00',
  transactions: [],
  waiverWatch: openWatch,
  feedMessages: [],
  marketSignals: [],
  rosterViews: [],
  feedStatus: 'disconnected',
});
assert.ok(waiverWatchSnapshot.includes('OPEN WAIVER WATCH — LAST 7 DAYS'));
assert.ok(waiverWatchSnapshot.includes('Jordan Addison'));
assert.ok(waiverWatchSnapshot.includes('Josh Downs'));
