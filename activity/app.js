const LEAGUE_ID = new URLSearchParams(window.location.search).get('league') || '1389332241724764160';
const API = 'https://api.sleeper.app/v1';
const PLAYER_CACHE_KEY = 'cloud-dynasty-players-nfl-v1';
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const els = {
  status: document.querySelector('#status'),
  hours: document.querySelector('#hours'),
  refresh: document.querySelector('#refresh'),
  copy: document.querySelector('#copy'),
  activity: document.querySelector('#activity'),
  rosters: document.querySelector('#rosters'),
  meta: document.querySelector('#meta'),
};

let state = {
  league: null,
  transactions: [],
  rosterSummaries: [],
  refreshedIso: null,
};

async function fetchJson(url) {
  const response = await fetch(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function buildTeams(users, rosters) {
  const usersById = Object.fromEntries((users || []).map(u => [String(u.user_id), u]));
  const teams = {};
  (rosters || []).forEach(roster => {
    const user = usersById[String(roster.owner_id)] || {};
    const metadata = user.metadata || {};
    teams[String(roster.roster_id)] = metadata.team_name || user.display_name || user.username || `Roster ${roster.roster_id}`;
  });
  return teams;
}

function candidateWeeks(nflState) {
  const week = Number(nflState?.week || 1);
  const leg = Number(nflState?.leg || week);
  return [...new Set([0, 1, week, leg, Math.max(1, week - 1), Math.max(1, leg - 1)])].sort((a, b) => a - b);
}

function collectPlayerIds(transactions, rosters) {
  const ids = new Set();
  (transactions || []).forEach(tx => {
    Object.keys(tx.adds || {}).forEach(id => ids.add(String(id)));
    Object.keys(tx.drops || {}).forEach(id => ids.add(String(id)));
  });
  (rosters || []).forEach(r => {
    [...(r.players || []), ...(r.taxi || []), ...(r.reserve || [])].forEach(id => ids.add(String(id)));
  });
  return ids;
}

async function loadCompactPlayers() {
  try {
    return await fetchJson('../data/players.json');
  } catch (_) {
    return {};
  }
}

function readCachedFullPlayers() {
  try {
    const cached = JSON.parse(localStorage.getItem(PLAYER_CACHE_KEY) || 'null');
    if (!cached || !cached.savedAt || !cached.players) return null;
    if (Date.now() - cached.savedAt > PLAYER_CACHE_TTL_MS) return null;
    return cached.players;
  } catch (_) {
    return null;
  }
}

async function loadFullPlayers() {
  const cached = readCachedFullPlayers();
  if (cached) return cached;
  els.status.textContent = 'Resolving player names from Sleeper…';
  const players = await fetchJson(`${API}/players/nfl`);
  try {
    localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({savedAt: Date.now(), players}));
  } catch (_) {
    // localStorage may be unavailable or too small; the page still works.
  }
  return players;
}

function playerLabel(pid, players) {
  const p = players[String(pid)] || {};
  const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || String(pid);
  const pos = p.position || '';
  const team = p.team || '';
  return `${name}${pos ? ` (${pos}${team ? `, ${team}` : ''})` : ''}`;
}

function rosterSummary(roster, teamName, players) {
  const groups = {QB: [], RB: [], WR: [], TE: [], OTHER: []};
  const rosterIds = [...new Set([...(roster.players || []), ...(roster.taxi || []), ...(roster.reserve || [])].map(String))];
  rosterIds.forEach(pid => {
    const p = players[String(pid)] || {};
    const pos = ['QB', 'RB', 'WR', 'TE'].includes(p.position) ? p.position : 'OTHER';
    groups[pos].push(playerLabel(pid, players));
  });
  const parts = Object.entries(groups)
    .filter(([, values]) => values.length)
    .map(([pos, values]) => `${pos}: ${values.join(', ')}`);
  return `${teamName} — ${parts.join('; ')}`;
}

function renderActivity(transactions) {
  els.activity.innerHTML = '';
  if (!transactions.length) {
    els.activity.innerHTML = '<div class="empty">No completed transactions in this window.</div>';
    return;
  }
  transactions.forEach(tx => {
    const card = document.createElement('article');
    card.className = `card type-${tx.type}`;
    const d = new Date(tx.created_ms);
    const when = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    card.innerHTML = `
      <div class="card-top">
        <span class="badge">${tx.type.replace('_', ' ').toUpperCase()}</span>
        <span class="time">${when} ET</span>
      </div>
      <div class="summary"></div>
    `;
    card.querySelector('.summary').textContent = tx.summary;
    els.activity.appendChild(card);
  });
}

function renderRosters(lines) {
  els.rosters.innerHTML = '';
  if (!lines.length) {
    els.rosters.innerHTML = '<div class="empty">No teams were involved in the selected window.</div>';
    return;
  }
  lines.forEach(line => {
    const item = document.createElement('div');
    item.className = 'roster-line';
    item.textContent = line;
    els.rosters.appendChild(item);
  });
}

async function loadActivity() {
  els.refresh.disabled = true;
  els.copy.disabled = true;
  els.status.textContent = 'Reading live Sleeper activity…';

  try {
    const [league, users, rosters, nflState, compactPlayers] = await Promise.all([
      fetchJson(`${API}/league/${LEAGUE_ID}`),
      fetchJson(`${API}/league/${LEAGUE_ID}/users`),
      fetchJson(`${API}/league/${LEAGUE_ID}/rosters`),
      fetchJson(`${API}/state/nfl`),
      loadCompactPlayers(),
    ]);

    const weeks = candidateWeeks(nflState);
    const transactionGroups = await Promise.all(weeks.map(async week => {
      try {
        return await fetchJson(`${API}/league/${LEAGUE_ID}/transactions/${week}`);
      } catch (_) {
        return [];
      }
    }));

    const byId = new Map();
    transactionGroups.flat().forEach((tx, idx) => {
      const id = tx.transaction_id || `${tx.leg || 0}:${ActivityCore.transactionTimeMs(tx)}:${idx}`;
      byId.set(String(id), tx);
    });

    const hours = Number(els.hours.value || 24);
    const recentRaw = ActivityCore.filterRecent([...byId.values()], Date.now(), hours);
    let players = compactPlayers || {};
    const neededIds = collectPlayerIds(recentRaw, rosters);
    const missing = [...neededIds].filter(id => !players[id]);
    if (missing.length) {
      const fullPlayers = await loadFullPlayers();
      players = {...fullPlayers, ...players};
    }

    const teams = buildTeams(users, rosters);
    const currentOwnership = ActivityCore.buildCurrentOwnership(rosters);
    const normalized = recentRaw.map(tx => ActivityCore.normalizeTransaction(tx, teams, players, currentOwnership));
    const involvedIds = [...new Set(normalized.flatMap(tx => tx.roster_ids))].sort((a, b) => a - b);
    const rosterById = Object.fromEntries(rosters.map(r => [String(r.roster_id), r]));
    const rosterSummaries = involvedIds.map(rid => rosterSummary(
      rosterById[String(rid)] || {players: []},
      teams[String(rid)] || `Roster ${rid}`,
      players,
    ));

    const refreshedIso = new Date().toISOString();
    state = {league, transactions: normalized, rosterSummaries, refreshedIso};

    renderActivity(normalized);
    renderRosters(rosterSummaries);
    els.meta.textContent = `${league.name || 'Cloud Dynasty League'} • ${normalized.length} transaction${normalized.length === 1 ? '' : 's'} • ${hours}h window • Sleeper week ${nflState.week || nflState.leg || '?'}`;
    els.status.textContent = `Live activity loaded at ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/New_York'})} ET.`;
    els.copy.disabled = false;
  } catch (error) {
    console.error(error);
    els.status.textContent = `Could not load activity: ${error.message}`;
  } finally {
    els.refresh.disabled = false;
  }
}

async function copySnapshot() {
  const hours = Number(els.hours.value || 24);
  const text = ActivityCore.buildSnapshotText({
    leagueName: state.league?.name || 'Cloud Dynasty League',
    hours,
    refreshedIso: state.refreshedIso || new Date().toISOString(),
    transactions: state.transactions,
    rosterSummaries: state.rosterSummaries,
  });
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = 'ChatGPT activity snapshot copied.';
  } catch (_) {
    window.prompt('Copy this activity snapshot:', text);
  }
}

els.refresh.addEventListener('click', loadActivity);
els.copy.addEventListener('click', copySnapshot);
els.hours.addEventListener('change', loadActivity);
loadActivity();
