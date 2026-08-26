import {
  buildChatSnapshot,
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

function render() {
  const state = currentState();
  renderMetrics(state);
  renderUpcoming(state);
  renderRecent(state);
  renderBoard(state);
}

async function loadLiveContext(leagueId = LEAGUE_ID) {
  const [users, rosters] = await Promise.all([
    fetchJson(`/league/${leagueId}/users`),
    fetchJson(`/league/${leagueId}/rosters`),
  ]);
  liveState.users = users;
  liveState.rosters = rosters;
  populateRosterSelector(liveState);
}

async function refreshLive({ forceContext = false } = {}) {
  if (refreshInFlight || mode !== 'live') return;
  refreshInFlight = true;
  try {
    if (DIRECT_DRAFT_ID) {
      const draft = await fetchJson(`/draft/${DIRECT_DRAFT_ID}`);
      const contextLeagueId = draft?.league_id || LEAGUE_ID;
      if (forceContext || !liveState.users.length || !liveState.rosters.length) await loadLiveContext(contextLeagueId);
      const [picks, tradedPicks] = await Promise.all([
        fetchJson(`/draft/${DIRECT_DRAFT_ID}/picks`),
        fetchJson(`/draft/${DIRECT_DRAFT_ID}/traded_picks`),
      ]);
      liveState.drafts = [draft];
      liveState.draft = draft;
      liveState.picks = picks;
      liveState.tradedPicks = tradedPicks;
      liveState.refreshedAt = new Date().toISOString();
      populateDraftSelector([draft], draft);
      render();
      setStatus(`DIRECT DRAFT • ${draftDisplayName(draft)} • ${DIRECT_DRAFT_ID} • ${picks.length} picks received from Sleeper`, 'ok');
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
      liveState.refreshedAt = new Date().toISOString();
      render();
      setStatus('No Sleeper draft found for this league yet. Mock rehearsal is available.', 'warn');
      return;
    }
    const [draft, picks, tradedPicks] = await Promise.all([
      fetchJson(`/draft/${selected.draft_id}`),
      fetchJson(`/draft/${selected.draft_id}/picks`),
      fetchJson(`/draft/${selected.draft_id}/traded_picks`),
    ]);
    liveState.draft = draft;
    liveState.picks = picks;
    liveState.tradedPicks = tradedPicks;
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
