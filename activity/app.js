const LEAGUE_ID = new URLSearchParams(window.location.search).get('league') || '1389332241724764160';
const API = 'https://api.sleeper.app/v1';
const PLAYER_CACHE_KEY = 'cloud-dynasty-players-nfl-v1';
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SLEEPER_TOKEN_KEY = 'cloud-dynasty-sleeper-token';

const els = {
  status: document.querySelector('#status'),
  hours: document.querySelector('#hours'),
  refresh: document.querySelector('#refresh'),
  copy: document.querySelector('#copy'),
  activity: document.querySelector('#activity'),
  rosters: document.querySelector('#rosters'),
  meta: document.querySelector('#meta'),
  feedStatus: document.querySelector('#feed-status'),
  feedControls: document.querySelector('#feed-controls'),
  marketIntelligence: document.querySelector('#market-intelligence'),
  fullFeed: document.querySelector('#full-feed'),
};

let state = {
  league: null,
  transactions: [],
  feedMessages: [],
  marketSignals: [],
  rosterViews: [],
  feedStatus: 'disconnected',
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
  (rosters || []).forEach(roster => {
    [
      ...(roster.players || []),
      ...(roster.starters || []),
      ...(roster.taxi || []),
      ...(roster.reserve || []),
    ].forEach(id => ids.add(String(id)));
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
    // The activity page still works when the browser cannot cache this large response.
  }
  return players;
}

function easternTime(createdMs, includeWeekday = true) {
  const options = {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  };
  if (includeWeekday) options.weekday = 'short';
  return new Date(createdMs).toLocaleString('en-US', options);
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
    card.innerHTML = `
      <div class="card-top">
        <span class="badge"></span>
        <span class="time"></span>
      </div>
      <div class="summary"></div>
    `;
    card.querySelector('.badge').textContent = tx.type.replace('_', ' ').toUpperCase();
    card.querySelector('.time').textContent = `${easternTime(tx.created_ms)} ET`;
    card.querySelector('.summary').textContent = tx.summary;
    els.activity.appendChild(card);
  });
}

function renderMarketIntelligence(signals) {
  els.marketIntelligence.innerHTML = '';
  if (!signals.length) {
    const item = document.createElement('div');
    item.className = 'empty';
    item.textContent = state.feedStatus === 'connected'
      ? 'No explicit trade chatter or trade-block signals in this window.'
      : 'Connect the Sleeper feed to see league trade chatter and trade-block activity.';
    els.marketIntelligence.appendChild(item);
    return;
  }
  signals.forEach(signal => {
    const card = document.createElement('article');
    card.className = 'signal-card';
    const top = document.createElement('div');
    top.className = 'card-top';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = signal.signal_type === 'trade_block' ? 'TRADE BLOCK' : 'TRADE SIGNAL';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${easternTime(signal.created_ms)} ET`;
    top.append(badge, time);
    const manager = document.createElement('div');
    manager.className = 'feed-author';
    manager.textContent = signal.manager;
    const text = document.createElement('div');
    text.className = 'summary';
    text.textContent = signal.source_text;
    card.append(top, manager, text);
    els.marketIntelligence.appendChild(card);
  });
}

function renderFullFeed(messages) {
  els.fullFeed.innerHTML = '';
  if (state.feedStatus !== 'connected') {
    const item = document.createElement('div');
    item.className = 'empty';
    item.textContent = state.feedStatus === 'unauthorized'
      ? 'Sleeper rejected the saved token. Use Connect Sleeper Feed to replace it.'
      : state.feedStatus === 'blocked'
        ? 'The authenticated Sleeper feed could not connect. Public transactions and rosters are still live.'
        : 'Sleeper feed is not connected. Public transactions and rosters are still live.';
    els.fullFeed.appendChild(item);
    return;
  }
  if (!messages.length) {
    els.fullFeed.innerHTML = '<div class="empty">No Sleeper feed messages in this window.</div>';
    return;
  }
  messages.forEach(message => {
    const card = document.createElement('article');
    card.className = `feed-card feed-kind-${message.kind}`;
    const top = document.createElement('div');
    top.className = 'card-top';
    const author = document.createElement('span');
    author.className = 'feed-author';
    author.textContent = message.author_name || (message.author_is_bot ? 'Sleeper' : 'Unknown');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${easternTime(message.created_ms)} ET`;
    top.append(author, time);
    const kind = document.createElement('div');
    kind.className = 'feed-kind';
    kind.textContent = message.kind.replace('_', ' ').toUpperCase();
    const text = document.createElement('div');
    text.className = 'summary';
    text.textContent = ActivityCore.feedDisplayText(message);
    card.append(top, kind, text);
    els.fullFeed.appendChild(card);
  });
}

function rosterGroup(label, players) {
  const group = document.createElement('div');
  group.className = 'roster-group';
  const heading = document.createElement('strong');
  heading.textContent = `${label}: `;
  const value = document.createElement('span');
  value.textContent = players.length ? players.map(player => player.label).join(', ') : 'none';
  group.append(heading, value);
  return group;
}

function renderRosters(rosterViews) {
  els.rosters.innerHTML = '';
  if (!rosterViews.length) {
    els.rosters.innerHTML = '<div class="empty">No current rosters returned by Sleeper.</div>';
    return;
  }
  rosterViews.forEach(view => {
    const card = document.createElement('article');
    card.className = 'roster-card';
    const title = document.createElement('h3');
    title.textContent = view.team_name;
    card.append(
      title,
      rosterGroup('Active', view.active),
      rosterGroup('Taxi', view.taxi),
      rosterGroup('Reserve / IR', view.reserve),
    );
    els.rosters.appendChild(card);
  });
}

function currentToken() {
  try {
    return sessionStorage.getItem(SLEEPER_TOKEN_KEY) || '';
  } catch (_) {
    return '';
  }
}

function renderFeedControls() {
  els.feedControls.innerHTML = '';
  const connect = document.createElement('button');
  connect.type = 'button';
  connect.textContent = currentToken() ? 'Replace Sleeper Token' : 'Connect Sleeper Feed';
  connect.addEventListener('click', async () => {
    const token = window.prompt(
      'Paste your Sleeper authorization token here. Do not paste it into ChatGPT. It will be stored only for this browser session.'
    );
    if (!token || !token.trim()) return;
    try {
      sessionStorage.setItem(SLEEPER_TOKEN_KEY, token.trim());
    } catch (_) {
      els.feedStatus.textContent = 'This browser blocked session storage, so the Sleeper token could not be saved.';
      return;
    }
    renderFeedControls();
    await loadActivity();
  });
  els.feedControls.appendChild(connect);

  if (currentToken()) {
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.textContent = 'Forget Sleeper Token';
    forget.addEventListener('click', async () => {
      try { sessionStorage.removeItem(SLEEPER_TOKEN_KEY); } catch (_) { /* no-op */ }
      renderFeedControls();
      await loadActivity();
    });
    els.feedControls.appendChild(forget);
  }
}

function renderFeedStatus() {
  const count = state.feedMessages.length;
  if (state.feedStatus === 'connected') {
    els.feedStatus.textContent = `Connected for this browser session. ${count} message${count === 1 ? '' : 's'} in the selected window.`;
  } else if (state.feedStatus === 'unauthorized') {
    els.feedStatus.textContent = 'Sleeper rejected the token. Replace it to reconnect; public transactions and rosters still work.';
  } else if (state.feedStatus === 'blocked') {
    els.feedStatus.textContent = 'Sleeper feed could not connect. Public transactions and rosters still work.';
  } else if (state.feedStatus === 'unavailable') {
    els.feedStatus.textContent = 'Sleeper feed is temporarily unavailable. Public transactions and rosters still work.';
  } else {
    els.feedStatus.textContent = 'Not connected. Public transactions and rosters still work.';
  }
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
    const nowMs = Date.now();
    const recentRaw = ActivityCore.filterRecent([...byId.values()], nowMs, hours);
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
    const rosterViews = rosters
      .slice()
      .sort((a, b) => Number(a.roster_id) - Number(b.roster_id))
      .map(roster => ActivityCore.buildRosterView(
        roster,
        teams[String(roster.roster_id)] || `Roster ${roster.roster_id}`,
        players,
      ));

    let feedMessages = [];
    let feedStatus = 'disconnected';
    const token = currentToken();
    if (token) {
      try {
        const sinceMs = nowMs - hours * 60 * 60 * 1000;
        const rawMessages = await SleeperFeed.fetchMessages({leagueId: LEAGUE_ID, token, sinceMs});
        feedMessages = ActivityCore.filterRecentFeed(rawMessages, nowMs, hours);
        feedStatus = 'connected';
      } catch (error) {
        feedStatus = error?.code === 'UNAUTHORIZED' ? 'unauthorized'
          : error?.code === 'NETWORK_OR_CORS' ? 'blocked'
          : 'unavailable';
      }
    }
    const marketSignals = ActivityCore.extractMarketSignals(feedMessages);

    const refreshedIso = new Date().toISOString();
    state = {
      league,
      transactions: normalized,
      feedMessages,
      marketSignals,
      rosterViews,
      feedStatus,
      refreshedIso,
    };

    renderActivity(normalized);
    renderMarketIntelligence(marketSignals);
    renderFullFeed(feedMessages);
    renderRosters(rosterViews);
    renderFeedStatus();
    renderFeedControls();

    els.meta.textContent = `${league.name || 'Cloud Dynasty League'} • ${normalized.length} transaction${normalized.length === 1 ? '' : 's'} • ${feedMessages.length} feed message${feedMessages.length === 1 ? '' : 's'} • ${hours}h window • Sleeper week ${nflState.week || nflState.leg || '?'}`;
    els.status.textContent = `Live league data loaded at ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/New_York'})} ET.`;
    els.copy.disabled = false;
  } catch (error) {
    console.error(error);
    els.status.textContent = `Could not load public Sleeper activity: ${error.message}`;
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
    feedMessages: state.feedMessages,
    marketSignals: state.marketSignals,
    rosterViews: state.rosterViews,
    feedStatus: state.feedStatus,
  });
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = 'ChatGPT league intelligence snapshot copied.';
  } catch (_) {
    window.prompt('Copy this league intelligence snapshot:', text);
  }
}

els.refresh.addEventListener('click', loadActivity);
els.copy.addEventListener('click', copySnapshot);
els.hours.addEventListener('change', loadActivity);
renderFeedControls();
loadActivity();
