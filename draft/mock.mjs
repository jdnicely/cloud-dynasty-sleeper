import { resolvePickOwner } from './core.mjs';

const POSITIONS = ['QB', 'RB', 'WR', 'WR', 'TE', 'RB', 'WR', 'QB', 'RB', 'WR', 'TE', 'WR'];
const NFL_TEAMS = ['ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU'];

function makeUsers() {
  return Array.from({ length: 12 }, (_, index) => ({
    user_id: `mock-user-${index + 1}`,
    display_name: `Mock Team ${index + 1}`,
    metadata: { team_name: `Mock Team ${index + 1}` },
  }));
}

function makeRosters() {
  return Array.from({ length: 12 }, (_, index) => ({
    roster_id: index + 1,
    owner_id: `mock-user-${index + 1}`,
  }));
}

function makeProspects() {
  return Array.from({ length: 48 }, (_, index) => {
    const n = index + 1;
    return {
      player_id: `mock-player-${String(n).padStart(2, '0')}`,
      metadata: {
        first_name: 'Prospect',
        last_name: String(n).padStart(2, '0'),
        position: POSITIONS[index % POSITIONS.length],
        team: NFL_TEAMS[index % NFL_TEAMS.length],
      },
    };
  });
}

export function createMockState() {
  const slotToRoster = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index + 1), index + 1]));
  return {
    mode: 'mock',
    draft: {
      draft_id: 'mock-cloud-dynasty-2026',
      league_id: '1389332241724764160',
      type: 'linear',
      status: 'drafting',
      start_time: Date.now(),
      created: Date.now(),
      settings: { teams: 12, rounds: 4, pick_timer: 120 },
      metadata: { name: 'Cloud Dynasty Mock Rookie Draft' },
      slot_to_roster_id: slotToRoster,
    },
    picks: [],
    tradedPicks: [
      { season: '2026', round: 2, roster_id: 5, previous_owner_id: 5, owner_id: 1 },
      { season: '2026', round: 3, roster_id: 1, previous_owner_id: 1, owner_id: 8 },
    ],
    users: makeUsers(),
    rosters: makeRosters(),
    selectedRosterId: 1,
    refreshedAt: new Date().toISOString(),
    prospects: makeProspects(),
  };
}

export function advanceMock(state, count = 1) {
  const next = structuredClone(state);
  const teams = Number(next.draft.settings.teams);
  const maxPicks = teams * Number(next.draft.settings.rounds);
  const target = Math.min(maxPicks, next.picks.length + Math.max(0, Number(count) || 0));

  while (next.picks.length < target) {
    const pickNo = next.picks.length + 1;
    const round = Math.floor((pickNo - 1) / teams) + 1;
    const slot = ((pickNo - 1) % teams) + 1;
    const prospect = next.prospects[pickNo - 1];
    const owner = resolvePickOwner(round, slot, next.draft, next.tradedPicks);
    next.picks.push({
      draft_id: next.draft.draft_id,
      pick_no: pickNo,
      round,
      draft_slot: slot,
      roster_id: owner,
      picked_by: next.rosters.find((roster) => Number(roster.roster_id) === Number(owner))?.owner_id ?? '',
      player_id: prospect.player_id,
      metadata: { ...prospect.metadata, player_id: prospect.player_id, sport: 'nfl' },
      is_keeper: null,
    });
  }

  next.draft.status = next.picks.length >= maxPicks ? 'complete' : 'drafting';
  next.refreshedAt = new Date().toISOString();
  return next;
}

export function resetMock() {
  return createMockState();
}
