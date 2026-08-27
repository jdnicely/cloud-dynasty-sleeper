import {
  applyLeagueMockReferenceDraft,
  buildChatSnapshot,
  buildAvailableRookies,
  buildDiagnostics,
  buildDraftHaul,
  buildRosterCapacity,
  compactSleeperRookieBoard,
  buildEffectiveSlotToRosterId,
  chooseDraftId,
  buildUpcomingPicks,
  formatPickLabel,
  nextOverallPick,
  overallPickNumber,
  playerLabel,
  resolveDraftPickRosterId,
  resolvePickOwner,
  rosterLabel,
  selectEffectiveTradedPicks,
  selectReferenceLeagueDraft,
  selectPreferredDraft,
} from './core.mjs';
import { advanceMock, createMockState, resetMock } from './mock.mjs';

const searchParams = new URLSearchParams(window.location.search);
const LEAGUE_ID = searchParams.get('league') || '1389332241724764160';
const DIRECT_DRAFT_ID = (searchParams.get('draft') || '').trim() || null;
const API_BASE = 'https://api.sleeper.app/v1';
const POLL_INTERVAL_MS = 5000;
const LIVE_ROSTER_STORAGE_KEY = 'cloud-dynasty-my-roster-id';
const MOCK_ROSTER_STORAGE_KEY = 'cloud-dynasty-mock-roster-id';
const ROOKIE_CACHE_KEY = 'cloud-dynasty-rookie-board-v1';
const ROOKIE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const elements = {
  modeLive: $('mode-live'),
  modeMock: $('mode-mock'),
  draftSelect: $('draft-select'),
  rosterSelect: $('roster-select'),
  manualRefresh: $('manual-refresh'),
  copySnapshot: $('copy-snapshot'),
  mockControls: $('mock-controls'),
  advanceOne: $('advance-one'),
  advanceFive: $('advance-five'),
  resetMock: $('reset-mock'),
  statusBanner: $('status-banner'),
  draftName: $('draft-name'),
  draftStatus: $('draft-status'),
  currentPick: $('current-pick'),
  currentOwner: $('current-owner'),
  lastRefresh: $('last-refresh'),
  refreshNote: $('refresh-note'),
  upcomingPicks: $('upcoming-picks'),
  recentPicks: $('recent-picks'),
  draftBoard: $('draft-board'),
  diagnosticLiveDraft: $('diagnostic-live-draft'),
  diagnosticReferenceDraft: $('diagnostic-reference-draft'),
  diagnosticTradeSource: $('diagnostic-trade-source'),
  diagnosticMapping: $('diagnostic-mapping'),
  diagnosticLastPoll: $('diagnostic-last-poll'),
  availableRookies: $('available-rookies'),
  completeSummary: $('draft-complete-summary'),
  completeContent: $('draft-complete-content'),
};

let mode = searchParams.get('mock') === '1' ? 'mock' : 'live';
let liveState = {
  mode: 'live',
  drafts: [],
  draft: null,
  picks: [],
  tradedPicks: [],
  users: [],
  rosters: [],
  selectedRosterId: null,
  refreshedAt: null,
  referenceDraft: null,
  league: null,
  contextLeagueId: LEAGUE_ID,
  tradedPickSource: 'unknown',
  playerDirectory: {},
  rookieBoard: [],
  playerContextLoading: false,
};
let mockState = createMockState();
let pollHandle = null;
let refreshInFlight = false;
let manualDraftId = DIRECT_DRAFT_ID || 'auto';

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status} for ${path}`);
  return response.json();
}


async function fetchSiteJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Site returned HTTP ${response.status} for ${path}`);
  return response.json();
}

function loadCachedRookieBoard() {
  try {
    const cached = JSON.parse(localStorage.getItem(ROOKIE_CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.players) || !Number.isFinite(Number(cached.fetchedAt))) return null;
    if (Date.now() - Number(cached.fetchedAt) > ROOKIE_CACHE_TTL_MS) return null;
    return cached.players;
  } catch {
    return null;
  }
}

function cacheRookieBoard(players) {
  try {
    localStorage.setItem(ROOKIE_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), players }));
  } catch (error) {
    console.warn('Unable to cache compact Sleeper rookie board', error);
  }
}

function mergeRookiesIntoDirectory(directory, rookies) {
  const result = { ...(directory ?? {}) };
  for (const rookie of rookies ?? []) {
    result[String(rookie.player_id)] = {
      ...(result[String(rookie.player_id)] ?? {}),
      full_name: rookie.name,
      position: rookie.position,
      team: rookie.team,
      search_rank: rookie.search_rank,
      years_exp: 0,
    };
  }
  return result;
}

async function loadPlayerContext() {
  if (liveState.playerContextLoading) return;
  liveState.playerContextLoading = true;
  try {
    if (!Object.keys(liveState.playerDirectory ?? {}).length) {
      try {
        const leaguePlayers = await fetchSiteJson('../data/players.json');
        if (leaguePlayers && typeof leaguePlayers === 'object') liveState.playerDirectory = leaguePlayers;
      } catch (error) {
        console.warn('League player cache unavailable; continuing with Sleeper rookie board', error);
      }
    }

    let rookieBoard = loadCachedRookieBoard();
    if (!rookieBoard) {
      const allPlayers = await fetchJson('/players/nfl');
      rookieBoard = compactSleeperRookieBoard(allPlayers).slice(0, 250);
      cacheRookieBoard(rookieBoard);
    }
    liveState.rookieBoard = rookieBoard;
    liveState.playerDirectory = mergeRookiesIntoDirectory(liveState.playerDirectory, rookieBoard);
    render();
  } catch (error) {
    console.warn('Sleeper rookie player board unavailable', error);
  } finally {
    liveState.playerContextLoading = false;
  }
}

function tradedPickSource(draftTradedPicks, leagueTradedPicks, season) {
  if (Array.isArray(draftTradedPicks) && draftTradedPicks.length) return 'draft';
  const wantedSeason = String(season ?? '').trim();
  const matchingLeague = (Array.isArray(leagueTradedPicks) ? leagueTradedPicks : []).filter(
    (item) => !wantedSeason || String(item?.season ?? '') === wantedSeason,
  );
  return matchingLeague.length ? 'league fallback' : 'none';
}

function setStatus(message, kind = '') {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${kind}`.trim();
}

function currentState() {
  return mode === 'mock' ? mockState : liveState;
}

function rosterStorageKey() {
  return mode === 'mock' ? MOCK_ROSTER_STORAGE_KEY : LIVE_ROSTER_STORAGE_KEY;
}

function ownerName(rosterId, state = currentState()) {
  return rosterLabel(rosterId, state.rosters, state.users).replace(/ \(Roster \d+\)$/, '');
}

function draftDisplayName(draft) {
  return draft?.metadata?.name || `${draft?.season ?? ''} ${draft?.type ?? ''} draft`.trim() || `Draft ${draft?.draft_id ?? ''}`;
}

function populateDraftSelector(drafts, selectedDraft) {
  if (DIRECT_DRAFT_ID) {
    elements.draftSelect.innerHTML = '';
    const option = document.createElement('option');
    option.value = DIRECT_DRAFT_ID;
    option.textContent = `DIRECT DRAFT • ${draftDisplayName(selectedDraft)} • ${DIRECT_DRAFT_ID}`;
    elements.draftSelect.append(option);
    elements.draftSelect.value = DIRECT_DRAFT_ID;
    elements.draftSelect.title = `Direct draft override: ${DIRECT_DRAFT_ID}`;
    return;
  }
  const previous = manualDraftId;
  elements.draftSelect.innerHTML = '<option value="auto">Auto-detect active draft</option>';
  for (const draft of drafts ?? []) {
    const option = document.createElement('option');
    option.value = String(draft.draft_id);
    option.textContent = `${draftDisplayName(draft)} — ${draft.status ?? 'unknown'}`;
    elements.draftSelect.append(option);
  }
  if (previous !== 'auto' && (drafts ?? []).some((draft) => String(draft.draft_id) === previous)) {
    elements.draftSelect.value = previous;
  } else {
    manualDraftId = 'auto';
    elements.draftSelect.value = 'auto';
  }
  elements.draftSelect.title = selectedDraft ? `Currently showing ${draftDisplayName(selectedDraft)}` : 'No Sleeper draft found';
}

function populateRosterSelector(state) {
  const remembered = localStorage.getItem(rosterStorageKey());
  const current = state.selectedRosterId != null ? String(state.selectedRosterId) : remembered;
  elements.rosterSelect.innerHTML = '<option value="">Choose my roster</option>';
  for (const roster of [...(state.rosters ?? [])].sort((a, b) => Number(a.roster_id) - Number(b.roster_id))) {
    const option = document.createElement('option');
    option.value = String(roster.roster_id);
    option.textContent = rosterLabel(roster.roster_id, state.rosters, state.users);
    elements.rosterSelect.append(option);
  }
  if (current && (state.rosters ?? []).some((roster) => String(roster.roster_id) === current)) {
    elements.rosterSelect.value = current;
    state.selectedRosterId = Number(current);
  } else {
    elements.rosterSelect.value = '';
    state.selectedRosterId = null;
  }
}

function futurePickByNumber(draft, tradedPicks, pickNo, rosters = []) {
  const teams = Number(draft?.settings?.teams ?? 0);
  const rounds = Number(draft?.settings?.rounds ?? 0);
  for (let round = 1; round <= rounds; round += 1) {
    for (let slot = 1; slot <= teams; slot += 1) {
      const number = overallPickNumber(round, slot, teams, draft?.type);
      if (number === Number(pickNo)) {
        return { round, slot, ownerRosterId: resolvePickOwner(round, slot, draft, tradedPicks, rosters) };
      }
    }
  }
  return null;
}

function renderMetrics(state) {
  const draft = state.draft;
  if (!draft) {
    elements.draftName.textContent = 'No draft found';
    elements.draftStatus.textContent = mode === 'mock' ? 'mock unavailable' : 'Sleeper has not returned a league draft';
    elements.currentPick.textContent = '—';
    elements.currentOwner.textContent = '—';
    elements.lastRefresh.textContent = state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString() : '—';
    return;
  }
  elements.draftName.textContent = draftDisplayName(draft);
  elements.draftStatus.textContent = `${draft.status ?? 'unknown'} • ${draft.type ?? 'draft'} • ${draft.settings?.rounds ?? '?'} rounds`;
  const nextPick = nextOverallPick(state.picks);
  const max = Number(draft.settings?.teams ?? 0) * Number(draft.settings?.rounds ?? 0);
  if (draft.status === 'complete' || (max && nextPick > max)) {
    elements.currentPick.textContent = 'Complete';
    elements.currentOwner.textContent = `${state.picks.length} picks made`;
  } else {
    const future = futurePickByNumber(draft, state.tradedPicks, nextPick, state.rosters);
    elements.currentPick.textContent = future ? `${formatPickLabel(future.round, future.slot)} • #${nextPick}` : `#${nextPick}`;
    elements.currentOwner.textContent = future?.ownerRosterId ? ownerName(future.ownerRosterId, state) : 'Owner unavailable';
  }
  elements.lastRefresh.textContent = state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString() : '—';
  elements.refreshNote.textContent = mode === 'mock' ? 'Simulation mode — no Sleeper calls' : DIRECT_DRAFT_ID ? `DIRECT DRAFT ${DIRECT_DRAFT_ID} • polls every 5 seconds` : 'Live mode polls every 5 seconds';
}

function renderUpcoming(state) {
  if (!state.draft || !state.selectedRosterId) {
    elements.upcomingPicks.className = 'pick-list empty-state';
    elements.upcomingPicks.textContent = state.selectedRosterId ? 'No draft loaded.' : 'Choose your roster above.';
    return;
  }
  const upcoming = buildUpcomingPicks(state.draft, state.picks, state.tradedPicks, state.selectedRosterId, state.rosters);
  if (!upcoming.length) {
    elements.upcomingPicks.className = 'pick-list empty-state';
    elements.upcomingPicks.textContent = 'No remaining picks owned by this roster.';
    return;
  }
  elements.upcomingPicks.className = 'pick-list';
  elements.upcomingPicks.innerHTML = upcoming.slice(0, 12).map((pick) => `
    <div class="pick-row">
      <span class="pick-label">${formatPickLabel(pick.round, pick.slot)}</span>
      <span>Overall #${pick.pickNo}</span>
      <span class="meta">${ownerName(pick.ownerRosterId, state)}</span>
    </div>`).join('');
}

function renderRecent(state) {
  const recent = [...(state.picks ?? [])].sort((a, b) => Number(b.pick_no ?? 0) - Number(a.pick_no ?? 0)).slice(0, 8);
  if (!recent.length) {
    elements.recentPicks.className = 'pick-list empty-state';
    elements.recentPicks.textContent = 'No picks yet.';
    return;
  }
  elements.recentPicks.className = 'pick-list';
  elements.recentPicks.innerHTML = recent.map((pick) => `
    <div class="pick-row">
      <span class="pick-label">${formatPickLabel(pick.round, pick.draft_slot)}</span>
      <span>${escapeHtml(playerLabel(pick))}</span>
      <span class="meta">${escapeHtml(ownerName(resolveDraftPickRosterId(pick, state.draft, state.rosters, state.tradedPicks), state))}</span>
    </div>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderBoard(state) {
  const draft = state.draft;
  if (!draft) {
    elements.draftBoard.innerHTML = '<div class="empty-state" style="padding:1rem">No draft board available. Mock Mode is still available for rehearsal.</div>';
    return;
  }
  const teams = Number(draft.settings?.teams ?? Object.keys(draft.slot_to_roster_id ?? {}).length);
  const rounds = Number(draft.settings?.rounds ?? 0);
  if (!teams || !rounds) {
    elements.draftBoard.innerHTML = '<div class="empty-state" style="padding:1rem">Sleeper draft settings do not include teams/rounds yet.</div>';
    return;
  }
  const pickedByCell = new Map((state.picks ?? []).map((pick) => [`${Number(pick.round)}:${Number(pick.draft_slot)}`, pick]));
  const currentPickNo = nextOverallPick(state.picks);
  const effectiveSlotMap = buildEffectiveSlotToRosterId(draft, state.rosters);
  const headers = Array.from({ length: teams }, (_, i) => i + 1).map((slot) => {
    const original = Number(effectiveSlotMap[String(slot)] ?? effectiveSlotMap[slot]);
    return `<th scope="col">Slot ${slot}<br><span>${escapeHtml(ownerName(original, state))}</span></th>`;
  }).join('');

  const rows = [];
  for (let round = 1; round <= rounds; round += 1) {
    const cells = [];
    for (let slot = 1; slot <= teams; slot += 1) {
      const pick = pickedByCell.get(`${round}:${slot}`);
      const pickNo = pick?.pick_no != null ? Number(pick.pick_no) : overallPickNumber(round, slot, teams, draft.type);
      const originalRosterId = Number(effectiveSlotMap[String(slot)] ?? effectiveSlotMap[slot]);
      const ownerRosterId = pick
        ? resolveDraftPickRosterId(pick, draft, state.rosters, state.tradedPicks)
        : resolvePickOwner(round, slot, draft, state.tradedPicks, state.rosters);
      const traded = Number.isFinite(originalRosterId) && Number.isFinite(ownerRosterId) && originalRosterId !== ownerRosterId;
      const classes = [pick ? '' : 'empty'];
      if (pickNo === currentPickNo && draft.status !== 'complete') classes.push('on-clock');
      if (state.selectedRosterId && ownerRosterId === Number(state.selectedRosterId)) classes.push('my-pick');
      cells.push(`
        <td class="${classes.join(' ').trim()}">
          <div class="board-cell ${pick ? '' : 'empty'}">
            <span class="pick-number">${formatPickLabel(round, slot)} • #${pickNo}</span>
            <span class="player">${escapeHtml(pick ? playerLabel(pick).replace(/ \([^)]*\)$/, '') : 'Available')}</span>
            <span class="position">${escapeHtml(pick ? [pick.metadata?.position, pick.metadata?.team].filter(Boolean).join(' • ') : '')}</span>
            <span class="owner">${escapeHtml(ownerName(ownerRosterId, state))}</span>
            ${traded ? '<span class="trade-badge">TRADED PICK</span>' : ''}
          </div>
        </td>`);
    }
    rows.push(`<tr><th scope="row">Round ${round}</th>${cells.join('')}</tr>`);
  }

  elements.draftBoard.innerHTML = `
    <table>
      <thead><tr><th scope="col">Round</th>${headers}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderDiagnostics(state) {
  const diagnostics = buildDiagnostics(state);
  elements.diagnosticLiveDraft.textContent = diagnostics.liveDraftId;
  elements.diagnosticReferenceDraft.textContent = diagnostics.referenceDraftId;
  elements.diagnosticTradeSource.textContent = diagnostics.tradeSource;
  elements.diagnosticMapping.textContent = diagnostics.mappingStatus;
  elements.diagnosticLastPoll.textContent = diagnostics.lastPoll === '—' ? '—' : new Date(diagnostics.lastPoll).toLocaleTimeString();
}

function renderAvailableRookies(state) {
  if (!state?.draft) {
    elements.availableRookies.className = 'available-grid empty-state';
    elements.availableRookies.textContent = 'No draft loaded.';
    return;
  }
  if (!(state?.rookieBoard ?? []).length) {
    elements.availableRookies.className = 'available-grid empty-state';
    elements.availableRookies.textContent = mode === 'live' ? 'Loading compact Sleeper rookie board…' : 'Available-player board is live-mode only.';
    return;
  }
  const available = buildAvailableRookies(state.rookieBoard, state.picks, state.rosters, 5);
  const rows = ['QB', 'RB', 'WR', 'TE'].flatMap((position) => {
    const players = available[position] ?? [];
    if (!players.length) return [];
    return [`<div class="available-position"><strong>${position}</strong><span>${players.map((player) => escapeHtml(`${player.name}${player.team ? ` (${player.team})` : ''}`)).join(' • ')}</span></div>`];
  });
  elements.availableRookies.className = 'available-grid';
  elements.availableRookies.innerHTML = rows.length ? rows.join('') : '<div class="empty-state">No undrafted rookies found in the cached Sleeper board.</div>';
}

function renderCompleteSummary(state) {
  const draft = state?.draft;
  const teams = Number(draft?.settings?.teams ?? 0);
  const rounds = Number(draft?.settings?.rounds ?? 0);
  const isComplete = Boolean(draft && (draft.status === 'complete' || (teams && rounds && (state?.picks ?? []).length >= teams * rounds)));
  elements.completeSummary.hidden = !isComplete;
  if (!isComplete) return;
  if (!state?.selectedRosterId) {
    elements.completeContent.className = 'empty-state';
    elements.completeContent.textContent = 'Choose your roster above to see your final draft haul and projected roster moves.';
    return;
  }
  const selectedRoster = (state.rosters ?? []).find((roster) => Number(roster?.roster_id) === Number(state.selectedRosterId)) ?? {};
  const haul = buildDraftHaul(draft, state.picks, state.tradedPicks, state.selectedRosterId, state.rosters);
  const capacity = buildRosterCapacity(state.league ?? {}, selectedRoster, haul);
  const haulHtml = haul.length
    ? `<ul>${haul.map((item) => `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.player)} — ${item.isAcquired ? 'acquired pick' : 'native'}</li>`).join('')}</ul>`
    : '<p>No selections attributed to this roster.</p>';
  elements.completeContent.className = 'summary-grid';
  elements.completeContent.innerHTML = `
    <div class="summary-box"><h3>Your haul</h3>${haulHtml}</div>
    <div class="summary-box">
      <h3>Roster headcount</h3>
      <p>Current players: <strong>${capacity.currentPlayers}</strong></p>
      <p>Draft additions not yet counted: <strong>${capacity.draftAdditions}</strong></p>
      <p>Projected: <strong>${capacity.projectedPlayers}/${capacity.totalCapacity}</strong></p>
      <p>Projected roster moves: <strong>${capacity.moveRange}</strong></p>
      <p>Absolute minimum if reserve slots are usable: <strong>${capacity.minimumMoves}</strong></p>
      <p>Capacity: ${capacity.baseSlots} active+bench + ${capacity.taxiSlots} taxi + ${capacity.reserveSlots} reserve.</p>
      <p><small>Taxi/reserve eligibility still determines the exact legal moves.</small></p>
    </div>`;
}

function render() {
  const state = currentState();
  renderMetrics(state);
  renderUpcoming(state);
  renderRecent(state);
  renderDiagnostics(state);
  renderAvailableRookies(state);
  renderCompleteSummary(state);
  renderBoard(state);
}

async function loadLiveContext(leagueId = LEAGUE_ID) {
  const [league, users, rosters] = await Promise.all([
    fetchJson(`/league/${leagueId}`),
    fetchJson(`/league/${leagueId}/users`),
    fetchJson(`/league/${leagueId}/rosters`),
  ]);
  liveState.league = league;
  liveState.users = users;
  liveState.rosters = rosters;
  liveState.contextLeagueId = String(leagueId);
  populateRosterSelector(liveState);
  void loadPlayerContext();
}

async function refreshLive({ forceContext = false } = {}) {
  if (refreshInFlight || mode !== 'live') return;
  refreshInFlight = true;
  try {
    if (DIRECT_DRAFT_ID) {
      const rawDraft = await fetchJson(`/draft/${DIRECT_DRAFT_ID}`);
      const contextLeagueId = rawDraft?.league_id || rawDraft?.metadata?.league_id || LEAGUE_ID;
      liveState.contextLeagueId = String(contextLeagueId);
      if (forceContext || !liveState.users.length || !liveState.rosters.length) await loadLiveContext(contextLeagueId);

      if (rawDraft?.metadata?.type === 'league_mock' && (!liveState.referenceDraft || forceContext)) {
        const leagueDrafts = await fetchJson(`/league/${contextLeagueId}/drafts`);
        const referenceCandidate = selectReferenceLeagueDraft(rawDraft, leagueDrafts);
        liveState.referenceDraft = referenceCandidate?.draft_id
          ? await fetchJson(`/draft/${referenceCandidate.draft_id}`)
          : null;
      }
      const draft = applyLeagueMockReferenceDraft(rawDraft, liveState.referenceDraft);

      const [picks, draftTradedPicks, leagueTradedPicks] = await Promise.all([
        fetchJson(`/draft/${DIRECT_DRAFT_ID}/picks`),
        fetchJson(`/draft/${DIRECT_DRAFT_ID}/traded_picks`),
        fetchJson(`/league/${contextLeagueId}/traded_picks`),
      ]);
      liveState.drafts = [draft];
      liveState.draft = draft;
      liveState.picks = picks;
      liveState.tradedPicks = selectEffectiveTradedPicks(draftTradedPicks, leagueTradedPicks, draft?.season);
      liveState.tradedPickSource = tradedPickSource(draftTradedPicks, leagueTradedPicks, draft?.season);
      liveState.refreshedAt = new Date().toISOString();
      populateDraftSelector([draft], draft);
      render();
      const referenceNote = draft?.reference_draft_id ? ` • order from league draft ${draft.reference_draft_id}` : '';
      setStatus(`DIRECT DRAFT • ${draftDisplayName(draft)} • ${DIRECT_DRAFT_ID}${referenceNote} • ${picks.length} picks received from Sleeper`, 'ok');
      return;
    }

    if (forceContext || !liveState.users.length || !liveState.rosters.length) await loadLiveContext();
    const drafts = await fetchJson(`/league/${LEAGUE_ID}/drafts`);
    liveState.drafts = drafts;
    const selectedDraftId = chooseDraftId({ directDraftId: null, manualDraftId, drafts });
    const selected = drafts.find((draft) => String(draft.draft_id) === String(selectedDraftId));
    populateDraftSelector(drafts, selected);
    if (!selected) {
      liveState.draft = null;
      liveState.picks = [];
      liveState.tradedPicks = [];
      liveState.tradedPickSource = 'none';
      liveState.refreshedAt = new Date().toISOString();
      render();
      setStatus('No Sleeper draft found for this league yet. Mock rehearsal is available.', 'warn');
      return;
    }
    const [draft, picks, draftTradedPicks, leagueTradedPicks] = await Promise.all([
      fetchJson(`/draft/${selected.draft_id}`),
      fetchJson(`/draft/${selected.draft_id}/picks`),
      fetchJson(`/draft/${selected.draft_id}/traded_picks`),
      fetchJson(`/league/${LEAGUE_ID}/traded_picks`),
    ]);
    liveState.draft = draft;
    liveState.picks = picks;
    liveState.tradedPicks = selectEffectiveTradedPicks(draftTradedPicks, leagueTradedPicks, draft?.season);
    liveState.tradedPickSource = tradedPickSource(draftTradedPicks, leagueTradedPicks, draft?.season);
    liveState.contextLeagueId = String(LEAGUE_ID);
    liveState.refreshedAt = new Date().toISOString();
    render();
    setStatus(`Live • ${draftDisplayName(draft)} • ${picks.length} picks received from Sleeper`, 'ok');
  } catch (error) {
    console.error(error);
    render();
    setStatus(`Live refresh failed: ${error.message}. Keeping the last good board and retrying automatically.`, 'error');
  } finally {
    refreshInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  if (mode === 'live') pollHandle = window.setInterval(() => refreshLive(), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle != null) window.clearInterval(pollHandle);
  pollHandle = null;
}

function setMode(nextMode) {
  mode = nextMode;
  const isMock = mode === 'mock';
  elements.modeLive.classList.toggle('active', !isMock);
  elements.modeMock.classList.toggle('active', isMock);
  elements.modeLive.setAttribute('aria-pressed', String(!isMock));
  elements.modeMock.setAttribute('aria-pressed', String(isMock));
  elements.mockControls.hidden = !isMock;
  elements.draftSelect.disabled = isMock || Boolean(DIRECT_DRAFT_ID);
  elements.manualRefresh.textContent = isMock ? 'Refresh view' : 'Refresh now';
  if (isMock) {
    const remembered = localStorage.getItem(rosterStorageKey());
    if (remembered && mockState.rosters.some((roster) => String(roster.roster_id) === remembered)) {
      mockState.selectedRosterId = Number(remembered);
    }
    populateRosterSelector(mockState);
    elements.draftSelect.innerHTML = '<option>Cloud Dynasty Mock Rookie Draft</option>';
    render();
    setStatus('Mock rehearsal • no Sleeper calls • use Advance pick / Advance 5 to simulate the room', 'ok');
  } else {
    populateRosterSelector(liveState);
    setStatus('Connecting to Sleeper…');
    refreshLive({ forceContext: true });
  }
  startPolling();
}

async function copySnapshot() {
  const text = buildChatSnapshot(currentState());
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied draft snapshot. Paste it into ChatGPT with “I’m on the clock.”', 'ok');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    setStatus('Copied draft snapshot using browser fallback.', 'ok');
  }
}

elements.modeLive.addEventListener('click', () => setMode('live'));
elements.modeMock.addEventListener('click', () => setMode('mock'));
elements.draftSelect.addEventListener('change', () => {
  if (DIRECT_DRAFT_ID) return;
  manualDraftId = elements.draftSelect.value || 'auto';
  refreshLive();
});
elements.rosterSelect.addEventListener('change', () => {
  const value = elements.rosterSelect.value;
  const selected = value ? Number(value) : null;
  currentState().selectedRosterId = selected;
  if (selected) localStorage.setItem(rosterStorageKey(), String(selected));
  else localStorage.removeItem(rosterStorageKey());
  render();
});
elements.manualRefresh.addEventListener('click', () => {
  if (mode === 'live') refreshLive({ forceContext: true });
  else {
    mockState.refreshedAt = new Date().toISOString();
    render();
    setStatus('Mock view refreshed.', 'ok');
  }
});
elements.copySnapshot.addEventListener('click', copySnapshot);
elements.advanceOne.addEventListener('click', () => {
  mockState = advanceMock(mockState, 1);
  populateRosterSelector(mockState);
  render();
});
elements.advanceFive.addEventListener('click', () => {
  mockState = advanceMock(mockState, 5);
  populateRosterSelector(mockState);
  render();
});
elements.resetMock.addEventListener('click', () => {
  const selected = mockState.selectedRosterId;
  mockState = resetMock();
  if (selected) mockState.selectedRosterId = selected;
  populateRosterSelector(mockState);
  render();
  setStatus('Mock draft reset to pick 1.01.', 'ok');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else {
    if (mode === 'live') refreshLive();
    startPolling();
  }
});

setMode(mode);
