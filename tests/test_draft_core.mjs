import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  selectPreferredDraft,
  overallPickNumber,
  resolvePickOwner,
  buildUpcomingPicks,
  buildChatSnapshot,
  rosterLabel,
  nextOverallPick,
} from '../draft/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function baseDraft(overrides = {}) {
  return {
    draft_id: 'd1',
    league_id: '1389332241724764160',
    type: 'linear',
    status: 'drafting',
    start_time: 1000,
    created: 900,
    settings: { teams: 4, rounds: 3, pick_timer: 60 },
    metadata: { name: 'Cloud Dynasty Rookie Draft' },
    slot_to_roster_id: { '1': 10, '2': 20, '3': 30, '4': 40 },
    ...overrides,
  };
}

test('selectPreferredDraft prioritizes drafting over newer pre_draft and complete drafts', () => {
  const drafts = [
    baseDraft({ draft_id: 'complete', status: 'complete', start_time: 3000 }),
    baseDraft({ draft_id: 'predraft', status: 'pre_draft', start_time: 4000 }),
    baseDraft({ draft_id: 'live', status: 'drafting', start_time: 2000 }),
  ];
  assert.equal(selectPreferredDraft(drafts).draft_id, 'live');
});

test('selectPreferredDraft falls back to newest pre_draft then newest draft', () => {
  const pre = [
    baseDraft({ draft_id: 'p1', status: 'pre_draft', start_time: 1000 }),
    baseDraft({ draft_id: 'p2', status: 'pre_draft', start_time: 2000 }),
  ];
  assert.equal(selectPreferredDraft(pre).draft_id, 'p2');

  const complete = [
    baseDraft({ draft_id: 'old', status: 'complete', start_time: 1000, created: 9999 }),
    baseDraft({ draft_id: 'new', status: 'complete', start_time: 5000, created: 1 }),
  ];
  assert.equal(selectPreferredDraft(complete).draft_id, 'new');
  assert.equal(selectPreferredDraft([]), null);
});

test('overallPickNumber handles linear and snake drafts', () => {
  assert.equal(overallPickNumber(1, 1, 4, 'linear'), 1);
  assert.equal(overallPickNumber(2, 1, 4, 'linear'), 5);
  assert.equal(overallPickNumber(1, 4, 4, 'snake'), 4);
  assert.equal(overallPickNumber(2, 4, 4, 'snake'), 5);
  assert.equal(overallPickNumber(2, 1, 4, 'snake'), 8);
  assert.equal(overallPickNumber(3, 1, 4, 'snake'), 9);
});

test('resolvePickOwner applies traded-pick ownership by original roster and round', () => {
  const draft = baseDraft();
  const traded = [
    { round: 2, roster_id: 20, previous_owner_id: 20, owner_id: 40 },
  ];
  assert.equal(resolvePickOwner(1, 2, draft, traded), 20);
  assert.equal(resolvePickOwner(2, 2, draft, traded), 40);
  assert.equal(resolvePickOwner(2, 3, draft, traded), 30);
});

test('buildUpcomingPicks returns unfilled picks currently owned by the selected roster', () => {
  const draft = baseDraft();
  const traded = [
    { round: 2, roster_id: 20, previous_owner_id: 20, owner_id: 40 },
  ];
  const picks = [
    { pick_no: 1, round: 1, draft_slot: 1, roster_id: 10, player_id: 'a' },
    { pick_no: 2, round: 1, draft_slot: 2, roster_id: 20, player_id: 'b' },
  ];
  const upcoming = buildUpcomingPicks(draft, picks, traded, 40);
  assert.deepEqual(
    upcoming.map((p) => [p.pickNo, p.round, p.slot, p.ownerRosterId]),
    [
      [4, 1, 4, 40],
      [6, 2, 2, 40],
      [8, 2, 4, 40],
      [12, 3, 4, 40],
    ],
  );
});

test('buildChatSnapshot includes current pick, selected roster, upcoming picks, and drafted players', () => {
  const draft = baseDraft({ settings: { teams: 4, rounds: 2, pick_timer: 60 } });
  const state = {
    draft,
    picks: [
      {
        pick_no: 1,
        round: 1,
        draft_slot: 1,
        roster_id: 10,
        player_id: 'p1',
        metadata: { first_name: 'Alex', last_name: 'Prospect', position: 'QB', team: 'ATL' },
      },
    ],
    tradedPicks: [],
    users: [{ user_id: 'u40', display_name: 'John' }],
    rosters: [{ roster_id: 40, owner_id: 'u40' }],
    selectedRosterId: 40,
    refreshedAt: '2026-08-25T17:00:00.000Z',
  };
  const text = buildChatSnapshot(state);
  assert.match(text, /Cloud Dynasty Rookie Draft/);
  assert.match(text, /Next overall pick: 2/);
  assert.match(text, /My roster: John \(Roster 40\)/);
  assert.match(text, /Upcoming owned picks:/);
  assert.match(text, /1\.04/);
  assert.match(text, /1\.01 — Alex Prospect \(QB, ATL\)/);
});



test('rosterLabel handles an unassigned pre-draft slot cleanly', () => {
  assert.equal(rosterLabel(null, [], []), 'Unassigned');
  assert.equal(rosterLabel(Number.NaN, [], []), 'Unassigned');
});

// Source-level smoke checks are appended by later implementation tasks.

import { createMockState, advanceMock, resetMock } from '../draft/mock.mjs';

test('mock state begins as an empty 12-team four-round draft', () => {
  const state = createMockState();
  assert.equal(state.mode, 'mock');
  assert.equal(state.draft.settings.teams, 12);
  assert.equal(state.draft.settings.rounds, 4);
  assert.equal(state.picks.length, 0);
  assert.equal(state.rosters.length, 12);
  assert.equal(state.users.length, 12);
});

test('advanceMock adds deterministic picks and caps at 48', () => {
  const state = createMockState();
  const five = advanceMock(state, 5);
  assert.equal(five.picks.length, 5);
  assert.equal(five.picks[0].pick_no, 1);
  assert.equal(five.picks[0].metadata.first_name, 'Prospect');
  assert.equal(five.picks[0].metadata.last_name, '01');
  assert.equal(five.picks[4].pick_no, 5);

  const finished = advanceMock(five, 100);
  assert.equal(finished.picks.length, 48);
  assert.equal(finished.draft.status, 'complete');
});

test('resetMock returns a fresh opening board', () => {
  const progressed = advanceMock(createMockState(), 9);
  assert.equal(progressed.picks.length, 9);
  const reset = resetMock();
  assert.equal(reset.picks.length, 0);
  assert.equal(reset.draft.status, 'drafting');
});

test('Draft Mode page exposes required controls and uses a 5000ms live poll', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'draft', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  for (const id of [
    'mode-live',
    'mode-mock',
    'draft-select',
    'roster-select',
    'manual-refresh',
    'copy-snapshot',
    'advance-one',
    'advance-five',
    'reset-mock',
    'draft-board',
    'recent-picks',
    'upcoming-picks',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /POLL_INTERVAL_MS\s*=\s*5000/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.match(html, /type=["']module["'][^>]+src=["']\.\/app\.js["']/i);
});

test('draft-day guide documents Pages, mock rehearsal, live mode, and ChatGPT handoff', () => {
  const guide = fs.readFileSync(path.join(repoRoot, 'DRAFT-DAY.md'), 'utf8');
  assert.match(guide, /https:\/\/jdnicely\.github\.io\/cloud-dynasty-sleeper\/draft\//);
  assert.match(guide, /Mock Mode|Mock rehearsal/i);
  assert.match(guide, /Live Mode|Live Sleeper/i);
  assert.match(guide, /Copy ChatGPT Snapshot/);
  assert.match(guide, /Sleeper mock draft/i);
  assert.match(guide, /I'm on the clock|I’m on the clock/);
});

test('Draft Mode supports a league query override for real test-league rehearsals', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  assert.match(app, /searchParams\.get\(['"]league['"]\)/);
  assert.match(app, /1389332241724764160/);
});

test('Live and mock modes use separate persisted roster selections', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  assert.match(app, /LIVE_ROSTER_STORAGE_KEY/);
  assert.match(app, /MOCK_ROSTER_STORAGE_KEY/);
});

test('direct draft ID takes priority even when it is absent from league draft discovery', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.chooseDraftId, 'function');
  const drafts = [baseDraft({ draft_id: 'real-league-draft', status: 'pre_draft' })];
  assert.equal(core.chooseDraftId({
    directDraftId: '1398157268502986752',
    manualDraftId: 'auto',
    drafts,
  }), '1398157268502986752');
});

test('Love and Tate at 1.01 and 1.02 advance the live board to 1.03', () => {
  const picks = [
    { pick_no: 1, round: 1, draft_slot: 1, metadata: { first_name: 'J.', last_name: 'Love', position: 'RB', team: 'ARI' } },
    { pick_no: 2, round: 1, draft_slot: 2, metadata: { first_name: 'C.', last_name: 'Tate', position: 'WR', team: 'TEN' } },
  ];
  assert.equal(nextOverallPick(picks), 3);
});

test('Draft Mode parses the draft query override and hides mock controls in live mode', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(repoRoot, 'draft', 'styles.css'), 'utf8');
  assert.match(app, /searchParams\.get\(['"]draft['"]\)/);
  assert.match(app, /DIRECT_DRAFT_ID/);
  assert.match(css, /#mock-controls\[hidden\][^{]*\{[^}]*display\s*:\s*none/i);
});

test('draft_order only fills slots missing from slot_to_roster_id', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    draft_order: { u6: 1, u1: 3 },
    slot_to_roster_id: { '2': 12, '3': 1 },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  const mapping = core.buildEffectiveSlotToRosterId(draft, rosters);
  assert.equal(mapping['1'], 6);
  assert.equal(mapping['2'], 12);
  assert.equal(mapping['3'], 1);
});

test('upcoming picks use authoritative slot map for native and acquired traded picks', () => {
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    draft_order: { u1: 1, u8: 8 },
    slot_to_roster_id: { '3': 1, '9': 8 },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  const traded = [{ round: 3, roster_id: 8, previous_owner_id: 8, owner_id: 1 }];
  const picks = [];
  for (let pickNo = 1; pickNo <= 14; pickNo += 1) {
    const round = Math.floor((pickNo - 1) / 12) + 1;
    const slot = ((pickNo - 1) % 12) + 1;
    picks.push({ pick_no: pickNo, round, draft_slot: slot, player_id: `p${pickNo}` });
  }
  const upcoming = buildUpcomingPicks(draft, picks, traded, 1, rosters);
  assert.deepEqual(
    upcoming.map((pick) => [pick.pickNo, pick.round, pick.slot]),
    [
      [15, 2, 3],
      [27, 3, 3],
      [33, 3, 9],
      [39, 4, 3],
      [51, 5, 3],
    ],
  );
});

test('pick owner falls back from missing roster_id to picked_by user via league roster ownership', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.resolveDraftPickRosterId, 'function');
  const draft = {
    ...baseDraft(),
    draft_order: { u1: 3 },
    slot_to_roster_id: { '1': 1, '2': 2, '3': 3, '4': 4 },
  };
  const rosters = [
    { roster_id: 1, owner_id: 'u1' },
    { roster_id: 2, owner_id: 'u2' },
    { roster_id: 3, owner_id: 'u3' },
    { roster_id: 4, owner_id: 'u4' },
  ];
  const pick = { pick_no: 3, round: 1, draft_slot: 3, picked_by: 'u1', roster_id: null };
  assert.equal(core.resolveDraftPickRosterId(pick, draft, rosters, []), 1);
});

test('snapshot reflects the selected roster actual draft slot and acquired third-round pick', () => {
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    draft_order: { u1: 1, u8: 8 },
    slot_to_roster_id: { '3': 1, '9': 8 },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  const users = [{ user_id: 'u1', display_name: 'HTTFFT' }];
  const tradedPicks = [{ round: 3, roster_id: 8, previous_owner_id: 8, owner_id: 1 }];
  const picks = [];
  for (let pickNo = 1; pickNo <= 14; pickNo += 1) {
    const round = Math.floor((pickNo - 1) / 12) + 1;
    const slot = ((pickNo - 1) % 12) + 1;
    picks.push({
      pick_no: pickNo,
      round,
      draft_slot: slot,
      player_id: `p${pickNo}`,
      picked_by: pickNo === 3 ? 'u1' : '',
      metadata: { first_name: `Prospect`, last_name: String(pickNo).padStart(2, '0'), position: 'WR', team: 'TEN' },
    });
  }
  const text = buildChatSnapshot({ draft, picks, tradedPicks, rosters, users, selectedRosterId: 1 });
  assert.match(text, /2\.03 \(overall 15\)/);
  assert.match(text, /3\.03 \(overall 27\)/);
  assert.match(text, /3\.09 \(overall 33\)/);
  assert.match(text, /1\.03 — Prospect 03 \(WR, TEN\) — HTTFFT \(Roster 1\)/);
});

test('mock draft falls back to current-season league traded picks when draft traded picks are empty', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.selectEffectiveTradedPicks, 'function');
  const leagueTrades = [
    { round: 2, season: '2026', roster_id: 2, owner_id: 10, previous_owner_id: 2 },
    { round: 3, season: '2026', roster_id: 8, owner_id: 1, previous_owner_id: 8 },
    { round: 5, season: '2027', roster_id: 8, owner_id: 4, previous_owner_id: 8 },
  ];
  assert.deepEqual(
    core.selectEffectiveTradedPicks([], leagueTrades, '2026'),
    leagueTrades.slice(0, 2),
  );
});

test('league fallback trade maps original roster 8 to slot 9 and gives roster 1 both 3.03 and 3.09', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    season: '2026',
    draft_order: { u1: 1, u8: 8 },
    slot_to_roster_id: { '3': 1, '9': 8 },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  const leagueTrades = [
    { round: 3, season: '2026', roster_id: 8, owner_id: 1, previous_owner_id: 8 },
    { round: 5, season: '2027', roster_id: 8, owner_id: 4, previous_owner_id: 8 },
  ];
  const traded = core.selectEffectiveTradedPicks([], leagueTrades, draft.season);
  const picks = [];
  for (let pickNo = 1; pickNo <= 14; pickNo += 1) {
    const round = Math.floor((pickNo - 1) / 12) + 1;
    const slot = ((pickNo - 1) % 12) + 1;
    picks.push({ pick_no: pickNo, round, draft_slot: slot, player_id: `p${pickNo}` });
  }
  const upcoming = core.buildUpcomingPicks(draft, picks, traded, 1, rosters);
  assert.deepEqual(
    upcoming.filter((pick) => pick.round === 3).map((pick) => [pick.pickNo, pick.round, pick.slot]),
    [[27, 3, 3], [33, 3, 9]],
  );
});

test('live Draft Mode fetches league traded picks as fallback for empty mock draft trade data', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  assert.match(app, /leagueTradedPicks/);
  assert.match(app, /\/league\/\$\{contextLeagueId\}\/traded_picks/);
  assert.match(app, /selectEffectiveTradedPicks/);
});

test('slot_to_roster_id remains authoritative when mock draft_order conflicts with league team order', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    draft_order: { u1: 3, u2: 2, u4: 4, u5: 5, u6: 6, u8: 8, u9: 9, u11: 11, u12: 12 },
    slot_to_roster_id: {
      '1': 6,
      '2': 12,
      '3': 1,
      '4': 2,
      '5': 9,
      '6': 11,
      '7': 4,
      '8': 5,
      '9': 8,
      '10': 10,
      '11': 3,
      '12': 7,
    },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  assert.deepEqual(core.buildEffectiveSlotToRosterId(draft, rosters), draft.slot_to_roster_id);
});

test('completed mock picks resolve by picked_by or draft slot before ambiguous raw roster_id', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    slot_to_roster_id: {
      '1': 6,
      '2': 12,
      '3': 1,
      '4': 2,
      '5': 9,
      '6': 11,
      '7': 4,
      '8': 5,
      '9': 8,
      '10': 10,
      '11': 3,
      '12': 7,
    },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));

  const anonymousSlotOne = { pick_no: 1, round: 1, draft_slot: 1, roster_id: null, picked_by: null };
  assert.equal(core.resolveDraftPickRosterId(anonymousSlotOne, draft, rosters, []), 6);

  const ambiguousSlotTwo = { pick_no: 2, round: 1, draft_slot: 2, roster_id: 2, picked_by: null };
  assert.equal(core.resolveDraftPickRosterId(ambiguousSlotTwo, draft, rosters, []), 12);

  const signedInSlotThree = { pick_no: 3, round: 1, draft_slot: 3, roster_id: 3, picked_by: 'u1' };
  assert.equal(core.resolveDraftPickRosterId(signedInSlotThree, draft, rosters, []), 1);
});

test('detached league mock uses the real league draft as its reference slot map', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.applyLeagueMockReferenceDraft, 'function');
  const mockDraft = {
    ...baseDraft({ draft_id: '1398157268502986752', league_id: null, status: 'paused', settings: { teams: 12, rounds: 5 } }),
    metadata: { name: 'Cloud Dynasty League', league_id: '1389332241724764160', type: 'league_mock', mock_traded_picks: 'on' },
    draft_order: { '327235334960058368': 3 },
    slot_to_roster_id: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), i + 1])),
  };
  const referenceDraft = {
    ...baseDraft({ draft_id: 'real-2026', league_id: '1389332241724764160', status: 'pre_draft', settings: { teams: 12, rounds: 5 } }),
    slot_to_roster_id: {
      '1': 6, '2': 12, '3': 1, '4': 2, '5': 9, '6': 11,
      '7': 4, '8': 5, '9': 8, '10': 10, '11': 3, '12': 7,
    },
  };
  const resolved = core.applyLeagueMockReferenceDraft(mockDraft, referenceDraft);
  assert.equal(resolved.draft_id, mockDraft.draft_id);
  assert.equal(resolved.status, 'paused');
  assert.deepEqual(resolved.slot_to_roster_id, referenceDraft.slot_to_roster_id);
  assert.equal(resolved.reference_draft_id, 'real-2026');
});

test('reference draft fixes HTTFFT native 2.03 and acquired 3.09 for the detached mock', async () => {
  const core = await import('../draft/core.mjs');
  const mockDraft = {
    ...baseDraft({ draft_id: 'mock', league_id: null, status: 'paused', settings: { teams: 12, rounds: 5 } }),
    season: '2026',
    metadata: { name: 'Cloud Dynasty League', league_id: '1389332241724764160', type: 'league_mock' },
    draft_order: { u1: 3 },
    slot_to_roster_id: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), i + 1])),
  };
  const referenceDraft = {
    ...baseDraft({ draft_id: 'real', status: 'pre_draft', settings: { teams: 12, rounds: 5 } }),
    season: '2026',
    slot_to_roster_id: {
      '1': 6, '2': 12, '3': 1, '4': 2, '5': 9, '6': 11,
      '7': 4, '8': 5, '9': 8, '10': 10, '11': 3, '12': 7,
    },
  };
  const draft = core.applyLeagueMockReferenceDraft(mockDraft, referenceDraft);
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));
  const leagueTrades = [{ round: 3, season: '2026', roster_id: 8, owner_id: 1, previous_owner_id: 8 }];
  const traded = core.selectEffectiveTradedPicks([], leagueTrades, '2026');
  const picks = Array.from({ length: 14 }, (_, i) => ({
    pick_no: i + 1,
    round: Math.floor(i / 12) + 1,
    draft_slot: (i % 12) + 1,
    player_id: `p${i + 1}`,
  }));
  const upcoming = core.buildUpcomingPicks(draft, picks, traded, 1, rosters);
  assert.deepEqual(
    upcoming.map((pick) => [pick.pickNo, pick.round, pick.slot]),
    [[15, 2, 3], [27, 3, 3], [33, 3, 9], [39, 4, 3], [51, 5, 3]],
  );
});

test('direct league mock fetches its real league draft as the team-order reference', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  assert.match(app, /metadata\?\.league_id/);
  assert.match(app, /selectReferenceLeagueDraft/);
  assert.match(app, /applyLeagueMockReferenceDraft/);
  assert.match(app, /\/league\/\$\{contextLeagueId\}\/drafts/);
});

test('reference-draft league mock attributes franchise by slot even when picked_by points to another league roster', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 12, rounds: 5, pick_timer: 60 } }),
    reference_draft_id: 'real-2026',
    slot_to_roster_id: {
      '1': 6, '2': 12, '3': 1, '4': 2, '5': 9, '6': 11,
      '7': 4, '8': 5, '9': 8, '10': 10, '11': 3, '12': 7,
    },
  };
  const rosters = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: `u${i + 1}` }));

  // Detached mocks may report the mock-seat participant in picked_by. The
  // franchise owner must still come from the real reference draft column.
  const slotTwoPick = { pick_no: 2, round: 1, draft_slot: 2, roster_id: 2, picked_by: 'u2' };
  assert.equal(core.resolveDraftPickRosterId(slotTwoPick, draft, rosters, []), 12);

  const slotElevenPick = { pick_no: 11, round: 1, draft_slot: 11, roster_id: 11, picked_by: 'u11' };
  assert.equal(core.resolveDraftPickRosterId(slotElevenPick, draft, rosters, []), 3);
});

test('compactSleeperRookieBoard keeps draftable rookies and sorts by Sleeper search rank', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.compactSleeperRookieBoard, 'function');
  const players = {
    qb1: { first_name: 'Alpha', last_name: 'QB', position: 'QB', team: 'LV', years_exp: 0, search_rank: 22, active: true },
    wr1: { first_name: 'Beta', last_name: 'WR', position: 'WR', team: 'TEN', years_exp: 0, search_rank: 9, active: true },
    vet: { first_name: 'Veteran', last_name: 'WR', position: 'WR', team: 'DAL', years_exp: 4, search_rank: 1, active: true },
    k1: { first_name: 'Kicker', last_name: 'Kid', position: 'K', team: 'GB', years_exp: 0, search_rank: 2, active: true },
    inactive: { first_name: 'Inactive', last_name: 'RB', position: 'RB', years_exp: 0, search_rank: 3, active: false },
  };
  assert.deepEqual(core.compactSleeperRookieBoard(players), [
    { player_id: 'wr1', name: 'Beta WR', position: 'WR', team: 'TEN', search_rank: 9 },
    { player_id: 'qb1', name: 'Alpha QB', position: 'QB', team: 'LV', search_rank: 22 },
  ]);
});

test('buildAvailableRookies excludes drafted and already-rostered players and groups by position', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.buildAvailableRookies, 'function');
  const rookieBoard = [
    { player_id: 'q1', name: 'QB One', position: 'QB', team: 'LV', search_rank: 1 },
    { player_id: 'q2', name: 'QB Two', position: 'QB', team: 'PIT', search_rank: 2 },
    { player_id: 'r1', name: 'RB One', position: 'RB', team: 'KC', search_rank: 3 },
    { player_id: 'r2', name: 'RB Two', position: 'RB', team: 'SEA', search_rank: 4 },
    { player_id: 'w1', name: 'WR One', position: 'WR', team: 'TEN', search_rank: 5 },
    { player_id: 't1', name: 'TE One', position: 'TE', team: 'NYJ', search_rank: 6 },
  ];
  const picks = [{ player_id: 'q1' }];
  const rosters = [{ players: ['r1'] }];
  assert.deepEqual(core.buildAvailableRookies(rookieBoard, picks, rosters, 2), {
    QB: [{ player_id: 'q2', name: 'QB Two', position: 'QB', team: 'PIT', search_rank: 2 }],
    RB: [{ player_id: 'r2', name: 'RB Two', position: 'RB', team: 'SEA', search_rank: 4 }],
    WR: [{ player_id: 'w1', name: 'WR One', position: 'WR', team: 'TEN', search_rank: 5 }],
    TE: [{ player_id: 't1', name: 'TE One', position: 'TE', team: 'NYJ', search_rank: 6 }],
  });
});

test('buildRosterGroups resolves selected roster by position and preserves taxi/reserve status', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.buildRosterGroups, 'function');
  const roster = {
    players: ['qb', 'rb', 'wr', 'te'],
    starters: ['qb', 'rb'],
    taxi: ['wr'],
    reserve: ['te'],
  };
  const directory = {
    qb: { first_name: 'Quarter', last_name: 'Back', position: 'QB', team: 'BAL' },
    rb: { first_name: 'Running', last_name: 'Back', position: 'RB', team: 'SEA' },
    wr: { first_name: 'Wide', last_name: 'Out', position: 'WR', team: 'KC' },
    te: { first_name: 'Tight', last_name: 'End', position: 'TE', team: 'NE' },
  };
  const groups = core.buildRosterGroups(roster, directory);
  assert.equal(groups.QB[0].name, 'Quarter Back');
  assert.equal(groups.QB[0].status, 'starter');
  assert.equal(groups.WR[0].status, 'taxi');
  assert.equal(groups.TE[0].status, 'reserve');
});

test('buildDraftHaul identifies native and acquired selections for the selected roster', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.buildDraftHaul, 'function');
  const draft = {
    ...baseDraft({ settings: { teams: 4, rounds: 3, pick_timer: 60 } }),
    slot_to_roster_id: { '1': 10, '2': 20, '3': 30, '4': 40 },
  };
  const traded = [{ round: 3, roster_id: 20, owner_id: 10, previous_owner_id: 20 }];
  const picks = [
    { pick_no: 1, round: 1, draft_slot: 1, player_id: 'a', metadata: { first_name: 'Native', last_name: 'One', position: 'QB', team: 'LV' } },
    { pick_no: 10, round: 3, draft_slot: 2, player_id: 'b', metadata: { first_name: 'Acquired', last_name: 'Two', position: 'WR', team: 'TEN' } },
  ];
  const haul = core.buildDraftHaul(draft, picks, traded, 10, []);
  assert.deepEqual(haul.map((item) => [item.label, item.player_id, item.isAcquired]), [
    ['1.01', 'a', false],
    ['3.02', 'b', true],
  ]);
});

test('buildRosterCapacity reports projected headcount and minimum moves after draft additions', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.buildRosterCapacity, 'function');
  const league = {
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    settings: { taxi_slots: 5, reserve_slots: 2 },
  };
  const roster = { players: Array.from({ length: 19 }, (_, i) => `p${i}`), taxi: ['p15', 'p16', 'p17', 'p18'], reserve: [] };
  const haul = Array.from({ length: 6 }, (_, i) => ({ player_id: `rookie${i}` }));
  const capacity = core.buildRosterCapacity(league, roster, haul);
  assert.equal(capacity.baseSlots, 15);
  assert.equal(capacity.taxiSlots, 5);
  assert.equal(capacity.reserveSlots, 2);
  assert.equal(capacity.currentPlayers, 19);
  assert.equal(capacity.projectedPlayers, 25);
  assert.equal(capacity.totalCapacity, 22);
  assert.equal(capacity.minimumMoves, 3);
  assert.equal(capacity.movesWithoutReserve, 5);
  assert.equal(capacity.moveRange, '3–5');
});

test('buildDiagnostics exposes draft ids, trade source, poll time, and slot-map completeness', async () => {
  const core = await import('../draft/core.mjs');
  assert.equal(typeof core.buildDiagnostics, 'function');
  const draft = {
    ...baseDraft({ settings: { teams: 4, rounds: 3 } }),
    reference_draft_id: 'reference-123',
    slot_to_roster_id: { '1': 10, '2': 20, '3': 30, '4': 40 },
  };
  const diagnostics = core.buildDiagnostics({
    draft,
    rosters: [{ roster_id: 10 }, { roster_id: 20 }, { roster_id: 30 }, { roster_id: 40 }],
    contextLeagueId: '1389332241724764160',
    tradedPickSource: 'league fallback',
    refreshedAt: '2026-08-27T00:42:16.201Z',
  });
  assert.deepEqual(diagnostics, {
    liveDraftId: 'd1',
    referenceDraftId: 'reference-123',
    leagueId: '1389332241724764160',
    tradeSource: 'league fallback',
    lastPoll: '2026-08-27T00:42:16.201Z',
    mappedSlots: 4,
    expectedSlots: 4,
    mappingStatus: '4/4 mapped',
  });
});

test('enriched ChatGPT snapshot includes roster, haul, capacity, available rookies, and diagnostics', async () => {
  const core = await import('../draft/core.mjs');
  const draft = {
    ...baseDraft({ settings: { teams: 4, rounds: 2 } }),
    slot_to_roster_id: { '1': 10, '2': 20, '3': 30, '4': 40 },
  };
  const state = {
    draft,
    league: { roster_positions: ['QB', 'RB', 'WR', 'TE', 'BN'], settings: { taxi_slots: 1, reserve_slots: 1 } },
    picks: [{ pick_no: 1, round: 1, draft_slot: 1, player_id: 'rookie-qb', metadata: { first_name: 'Rookie', last_name: 'QB', position: 'QB', team: 'LV' } }],
    tradedPicks: [],
    tradedPickSource: 'draft',
    contextLeagueId: '1389332241724764160',
    users: [{ user_id: 'u10', display_name: 'HTTFFT' }],
    rosters: [{ roster_id: 10, owner_id: 'u10', players: ['vet-qb'], starters: ['vet-qb'], taxi: [], reserve: [] }],
    selectedRosterId: 10,
    refreshedAt: '2026-08-27T00:42:16.201Z',
    playerDirectory: { 'vet-qb': { first_name: 'Veteran', last_name: 'QB', position: 'QB', team: 'BAL' } },
    rookieBoard: [
      { player_id: 'rookie-qb', name: 'Rookie QB', position: 'QB', team: 'LV', search_rank: 1 },
      { player_id: 'rookie-wr', name: 'Rookie WR', position: 'WR', team: 'TEN', search_rank: 2 },
    ],
  };
  const text = core.buildChatSnapshot(state);
  assert.match(text, /My current roster by position:/);
  assert.match(text, /QB: Veteran QB/);
  assert.match(text, /My draft additions:/);
  assert.match(text, /1\.01 — Rookie QB \(QB, LV\) — native/);
  assert.match(text, /Roster capacity:/);
  assert.match(text, /Top undrafted rookies \(Sleeper search rank\):/);
  assert.match(text, /WR: Rookie WR \(TEN\)/);
  assert.match(text, /Diagnostics:/);
  assert.match(text, /trade source: draft/);
});

test('Draft Mode page exposes diagnostics, available-rookie, and post-draft summary panels', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'draft', 'index.html'), 'utf8');
  for (const id of [
    'diagnostics-panel',
    'diagnostic-live-draft',
    'diagnostic-reference-draft',
    'diagnostic-trade-source',
    'diagnostic-mapping',
    'diagnostic-last-poll',
    'available-rookies',
    'draft-complete-summary',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('Draft Mode caches a compact Sleeper rookie board for 24 hours instead of polling the full player database', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'draft', 'app.js'), 'utf8');
  assert.match(app, /ROOKIE_CACHE_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(app, /\/players\/nfl/);
  assert.match(app, /compactSleeperRookieBoard/);
  assert.match(app, /localStorage/);
});
