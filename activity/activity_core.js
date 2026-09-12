(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ActivityCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function ordinal(n) {
    n = Number(n || 0);
    const mod100 = n % 100;
    const suffix = (mod100 >= 10 && mod100 <= 20)
      ? 'th'
      : ({1: 'st', 2: 'nd', 3: 'rd'}[n % 10] || 'th');
    return `${n}${suffix}`;
  }

  function pickLabel(pick) {
    return `${pick?.season ?? '?'} ${ordinal(pick?.round ?? 0)}`;
  }

  function playerName(playerId, players) {
    const value = players?.[String(playerId)];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      return value.full_name || [value.first_name, value.last_name].filter(Boolean).join(' ') || String(playerId);
    }
    return String(playerId);
  }

  function teamName(rosterId, teams) {
    return teams?.[String(rosterId)] || teams?.[Number(rosterId)] || `Roster ${rosterId}`;
  }

  function transactionTimeMs(tx) {
    return Number(tx?.created || tx?.status_updated || 0);
  }

  function filterRecent(transactions, nowMs, hours) {
    const cutoff = Number(nowMs) - Number(hours) * 60 * 60 * 1000;
    return (transactions || [])
      .filter(tx => tx?.status === 'complete' && transactionTimeMs(tx) >= cutoff)
      .sort((a, b) => transactionTimeMs(b) - transactionTimeMs(a));
  }

  function buildCurrentOwnership(rosters) {
    const ownership = {};
    (rosters || []).forEach(roster => {
      const rid = Number(roster?.roster_id);
      const ids = new Set([
        ...(roster?.players || []),
        ...(roster?.taxi || []),
        ...(roster?.reserve || []),
        ...(roster?.starters || []),
      ].map(String));
      ids.forEach(pid => { ownership[pid] = rid; });
    });
    return ownership;
  }

  function buildDropCheck(pid, sourceRosterId, teams, players, currentOwnership) {
    const player = playerName(pid, players);
    const currentOwner = currentOwnership?.[String(pid)];
    if (currentOwner == null) {
      return {
        player_id: String(pid),
        player_name: player,
        availability: 'unrostered_api',
        current_owner_roster_id: null,
        current_owner_name: null,
        label: `${player} [UNROSTERED PER PUBLIC API — VERIFY IN SLEEPER]`,
      };
    }
    const currentRid = Number(currentOwner);
    if (sourceRosterId != null && currentRid === Number(sourceRosterId)) {
      const owner = teamName(currentRid, teams);
      return {
        player_id: String(pid),
        player_name: player,
        availability: 'rostered_same',
        current_owner_roster_id: currentRid,
        current_owner_name: owner,
        label: `${player} [CURRENTLY STILL ON ${owner} ⚠️]`,
      };
    }
    const owner = teamName(currentRid, teams);
    return {
      player_id: String(pid),
      player_name: player,
      availability: 'rostered_other',
      current_owner_roster_id: currentRid,
      current_owner_name: owner,
      label: `${player} [CURRENTLY ROSTERED BY ${owner} ⚠️]`,
    };
  }

  function normalizeTransaction(tx, teams, players, currentOwnership = {}) {
    const type = String(tx?.type || 'transaction');
    const rosterIds = (tx?.roster_ids || []).map(Number);
    const adds = tx?.adds || {};
    const drops = tx?.drops || {};
    const picks = tx?.draft_picks || [];
    const budgets = tx?.waiver_budget || [];
    const settings = tx?.settings || {};
    let summary = '';
    let dropChecks = [];

    if (type === 'trade') {
      const incoming = {};
      rosterIds.forEach(rid => { incoming[rid] = []; });
      Object.entries(adds).forEach(([pid, rid]) => {
        const key = Number(rid);
        (incoming[key] ||= []).push(playerName(pid, players));
      });
      picks.forEach(pick => {
        const key = Number(pick.owner_id);
        (incoming[key] ||= []).push(pickLabel(pick));
      });
      budgets.forEach(budget => {
        const key = Number(budget.receiver);
        (incoming[key] ||= []).push(`$${Number(budget.amount || 0)} FAAB`);
      });
      const parts = rosterIds
        .filter(rid => (incoming[rid] || []).length)
        .map(rid => `${teamName(rid, teams)} receives: ${incoming[rid].join(', ')}`);
      summary = parts.length
        ? parts.join('; ')
        : `Trade between ${rosterIds.map(rid => teamName(rid, teams)).join(', ')}`;
    } else {
      const rid = rosterIds.length ? rosterIds[0] : null;
      const pieces = [rid == null ? 'Unknown team' : teamName(rid, teams)];
      const added = Object.keys(adds).map(pid => playerName(pid, players));
      dropChecks = Object.keys(drops).map(pid => buildDropCheck(pid, rid, teams, players, currentOwnership));
      if (added.length) pieces.push(`adds ${added.join(', ')}`);
      if (dropChecks.length) pieces.push(`drop event: ${dropChecks.map(x => x.label).join(', ')}`);
      if (settings.waiver_bid != null) pieces.push(`for $${Number(settings.waiver_bid)} FAAB`);
      summary = pieces.join(' — ');
    }

    return {
      transaction_id: tx?.transaction_id || null,
      type,
      created_ms: transactionTimeMs(tx),
      roster_ids: rosterIds,
      summary,
      drop_checks: dropChecks,
      raw: tx,
    };
  }


  function waiverWatchAgeLabel(createdMs, nowMs) {
    const ageMs = Math.max(0, Number(nowMs) - Number(createdMs || 0));
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function buildWaiverWatch(transactions, players, currentOwnership = {}, teams = {}, nowMs = Date.now(), days = 7) {
    const cutoff = Number(nowMs) - Number(days) * 24 * 60 * 60 * 1000;
    const latestDrops = new Map();

    (transactions || []).forEach(tx => {
      if (tx?.status !== 'complete') return;
      const createdMs = transactionTimeMs(tx);
      if (createdMs < cutoff || createdMs > Number(nowMs)) return;
      const sourceRosterId = Array.isArray(tx?.roster_ids) && tx.roster_ids.length ? Number(tx.roster_ids[0]) : null;
      Object.keys(tx?.drops || {}).forEach(pid => {
        const player = players?.[String(pid)] || {};
        const position = String(player?.position || '').toUpperCase();
        if (!['QB', 'RB', 'WR', 'TE'].includes(position)) return;
        const current = latestDrops.get(String(pid));
        if (!current || createdMs > current.created_ms) {
          latestDrops.set(String(pid), {
            player_id: String(pid),
            player_name: playerName(pid, players),
            position,
            nfl_team: player?.team || '',
            source_roster_id: sourceRosterId,
            source_team_name: sourceRosterId == null ? null : teamName(sourceRosterId, teams),
            created_ms: createdMs,
          });
        }
      });
    });

    return [...latestDrops.values()]
      .filter(item => currentOwnership?.[String(item.player_id)] == null)
      .sort((a, b) => Number(b.created_ms) - Number(a.created_ms))
      .map(item => ({
        ...item,
        age_label: waiverWatchAgeLabel(item.created_ms, nowMs),
        label: `${item.player_name} (${item.position}${item.nfl_team ? `, ${item.nfl_team}` : ''}) — dropped ${waiverWatchAgeLabel(item.created_ms, nowMs)}${item.source_team_name ? ` by ${item.source_team_name}` : ''} — CURRENT OWNER UNRESOLVED — WATCH`,
      }));
  }

  function formatEasternStamp(createdMs) {
    const d = new Date(createdMs);
    if (!Number.isFinite(d.getTime())) return 'unknown time';
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit',
    });
  }

  function formatReactionSummary(reactions) {
    if (!Array.isArray(reactions) || !reactions.length) return '';
    const values = reactions.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const name = item.reaction || item.emoji || item.name || 'reaction';
      const count = Number(item.count || 0);
      return count > 1 ? `${name} x${count}` : String(name);
    }).filter(Boolean);
    return values.length ? ` [reactions: ${values.join(', ')}]` : '';
  }

  function buildSnapshotText({
    leagueName,
    hours,
    refreshedIso,
    transactions = [],
    waiverWatch = [],
    feedMessages = [],
    marketSignals = [],
    rosterViews = [],
    rosterSummaries = [],
    feedStatus = 'disconnected',
  }) {
    const lines = [
      'CLOUD DYNASTY LEAGUE ACTIVITY SNAPSHOT',
      `League: ${leagueName || 'Cloud Dynasty League'}`,
      `Window: last ${hours} hours`,
      `Refreshed: ${refreshedIso}`,
      `Transactions: ${transactions.length}`,
      `Feed messages: ${feedMessages.length}`,
      '',
      'OPEN WAIVER WATCH — LAST 7 DAYS',
    ];

    if (!waiverWatch.length) {
      lines.push('- none');
    } else {
      waiverWatch.forEach(item => lines.push(`- ${item.label}`));
    }

    lines.push('', 'MARKET INTELLIGENCE');

    if (!marketSignals.length) {
      lines.push(feedStatus === 'connected' ? '- none' : '- Sleeper feed not connected');
    } else {
      [...marketSignals]
        .sort((a, b) => Number(a.created_ms) - Number(b.created_ms))
        .forEach(signal => {
          lines.push(`- [${formatEasternStamp(signal.created_ms)} ET] ${signal.manager} — ${signal.source_text}`);
        });
    }

    lines.push('', 'COMPLETED TRANSACTIONS');
    if (!transactions.length) {
      lines.push('- none');
    } else {
      transactions.forEach((tx, idx) => {
        lines.push(`${idx + 1}. [${formatEasternStamp(tx.created_ms)} ET] ${String(tx.type).toUpperCase()} — ${tx.summary}`);
      });
    }

    const checks = transactions.flatMap(tx => tx.drop_checks || []);
    const unrosteredApi = checks.filter(x => x.availability === 'unrostered_api');
    const mismatches = checks.filter(x => x.availability !== 'unrostered_api');

    lines.push('', 'Unrostered per public API — verify in Sleeper:');
    if (!unrosteredApi.length) lines.push('- none');
    else unrosteredApi.forEach(x => lines.push(`- ${x.player_name}`));

    lines.push('', 'Ownership mismatches / re-rostered players:');
    if (!mismatches.length) lines.push('- none');
    else mismatches.forEach(x => {
      const wording = x.availability === 'rostered_same'
        ? `still on ${x.current_owner_name}`
        : `currently on ${x.current_owner_name}`;
      lines.push(`- ${x.player_name} — ${wording}`);
    });

    lines.push('', 'FULL SLEEPER FEED');
    if (feedStatus !== 'connected') {
      const statusText = feedStatus === 'unauthorized'
        ? 'Sleeper feed authorization failed'
        : feedStatus === 'blocked'
          ? 'Sleeper feed could not connect'
          : 'Sleeper feed not connected';
      lines.push(`- ${statusText}`);
    } else if (!feedMessages.length) {
      lines.push('- no messages in this window');
    } else {
      [...feedMessages]
        .sort((a, b) => Number(a.created_ms) - Number(b.created_ms))
        .forEach(message => {
          const author = message.manager_name || message.author_name || (message.author_is_bot ? 'Sleeper' : 'Unknown');
          lines.push(`[${formatEasternStamp(message.created_ms)} ET] ${author}: ${message.display_text || feedDisplayText(message)}${formatReactionSummary(message.reactions)}`);
        });
    }

    lines.push('', 'CURRENT ROSTERS');
    if (rosterViews.length) {
      rosterViews.forEach(view => lines.push(`- ${formatRosterView(view)}`));
    } else if (rosterSummaries.length) {
      rosterSummaries.forEach(line => lines.push(`- ${line}`));
    } else {
      lines.push('- none');
    }

    return lines.join('\n');
  }

  function sanitizeFeedValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeFeedValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['authorization', 'token', 'password', 'cookie', 'cookies'].includes(String(key).toLowerCase()))
        .map(([key, item]) => [key, sanitizeFeedValue(item)]));
    }
    return value;
  }

  function stringifyCompact(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(stringifyCompact).filter(Boolean).join(' ');
    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([key]) => !['token', 'authorization', 'password', 'cookie', 'cookies'].includes(String(key).toLowerCase()))
        .map(([, item]) => stringifyCompact(item))
        .filter(Boolean)
        .join(' ');
    }
    return '';
  }

  function feedDisplayText(message) {
    const enriched = typeof message?.display_text === 'string' ? message.display_text.trim() : '';
    if (enriched) return enriched;

    const direct = typeof message?.text === 'string' ? message.text.trim() : '';
    if (direct) return direct;

    const mapped = stringifyCompact(message?.text_map).replace(/\s+/g, ' ').trim();
    if (mapped && mapped.toLowerCase() !== 'flair') return mapped;

    const attached = stringifyCompact(message?.attachment).replace(/\s+/g, ' ').trim();
    return attached || '[message with no text]';
  }

  function walkFeedValue(value, visit) {
    if (value == null) return;
    visit(value);
    if (Array.isArray(value)) {
      value.forEach(item => walkFeedValue(item, visit));
    } else if (typeof value === 'object') {
      Object.values(value).forEach(item => walkFeedValue(item, visit));
    }
  }

  function findFeedValueByKeys(value, keys) {
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));
    let found;
    function scan(item) {
      if (found !== undefined || item == null || typeof item !== 'object') return;
      if (!Array.isArray(item)) {
        for (const [key, child] of Object.entries(item)) {
          if (wanted.has(String(key).toLowerCase()) && child != null && typeof child !== 'object') {
            found = child;
            return;
          }
        }
      }
      const children = Array.isArray(item) ? item : Object.values(item);
      for (const child of children) {
        scan(child);
        if (found !== undefined) return;
      }
    }
    scan(value);
    return found;
  }

  function feedStrings(value) {
    const values = [];
    walkFeedValue(value, item => {
      if (typeof item === 'string' && item.trim()) values.push(item.trim());
    });
    return values;
  }

  function buildFeedIdentityMap(users, rosters, teams) {
    const ownerToRoster = {};
    (rosters || []).forEach(roster => {
      if (roster?.owner_id != null) ownerToRoster[String(roster.owner_id)] = Number(roster.roster_id);
    });
    const identity = {};
    (users || []).forEach(user => {
      const rid = ownerToRoster[String(user?.user_id)];
      const team = rid == null
        ? (user?.metadata?.team_name || user?.display_name || user?.username || String(user?.user_id || 'Unknown'))
        : teamName(rid, teams);
      [user?.user_id, user?.username, user?.display_name, user?.metadata?.team_name, team]
        .filter(value => value != null && String(value).trim())
        .forEach(value => { identity[String(value).trim().toLowerCase()] = team; });
    });
    return identity;
  }

  function resolveFeedManager(message, identityMap = {}) {
    const direct = typeof message?.text === 'string' ? message.text.trim() : '';
    const directMatch = direct.match(/^(.+?)\s+(?:made a roster move|put a player on the trade block)[:.]/i);
    const creator = findFeedValueByKeys(message?.attachment, ['creator', 'username', 'display_name', 'author_display_name']);
    const candidates = [
      directMatch?.[1],
      creator,
      message?.author_name,
      message?.author_id,
      ...feedStrings(message?.attachment),
    ].filter(value => value != null && String(value).trim());

    for (const candidate of candidates) {
      const resolved = identityMap[String(candidate).trim().toLowerCase()];
      if (resolved) return resolved;
    }
    if (directMatch?.[1]) return directMatch[1].trim();
    const author = String(message?.author_name || '').trim();
    return author && !/^sys$/i.test(author) ? author : (creator ? String(creator) : (message?.author_is_bot ? 'Sleeper' : 'Unknown'));
  }

  function extractFeedTransactionId(message) {
    const explicit = findFeedValueByKeys(message?.attachment, ['transaction_id', 'transactionId']);
    if (explicit != null && String(explicit).trim()) return String(explicit).trim();
    const candidate = feedStrings(message?.attachment).find(value => /^[0-9a-f]{32}$/i.test(value));
    return candidate || null;
  }

  function extractFeedPlayerRecords(value, players = {}) {
    const byName = {};
    Object.entries(players || {}).forEach(([id, player]) => {
      const name = typeof player === 'string'
        ? player
        : player?.full_name || [player?.first_name, player?.last_name].filter(Boolean).join(' ');
      if (name) byName[String(name).trim().toLowerCase()] = {
        player_id: String(id),
        name: String(name).trim(),
        position: typeof player === 'object' ? (player.position || '') : '',
        team: typeof player === 'object' ? (player.team || '') : '',
      };
    });

    const records = [];
    const seen = new Set();
    function add(record) {
      if (!record?.name) return;
      const key = `${record.player_id || ''}:${record.name.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      records.push(record);
    }
    function scan(item) {
      if (item == null) return;
      if (Array.isArray(item)) {
        item.forEach(scan);
        return;
      }
      if (typeof item !== 'object') return;

      const position = String(item.position || item.pos || '').toUpperCase();
      const name = item.full_name || item.player_name || item.playerName || null;
      const id = item.player_id || item.playerId || null;
      if (name && /^(QB|RB|WR|TE|K|DEF|DB|DL|LB)$/.test(position)) {
        add({
          player_id: id == null ? (byName[String(name).trim().toLowerCase()]?.player_id || null) : String(id),
          name: String(name).trim(),
          position,
          team: String(item.team || item.team_abbr || '').trim(),
        });
      }

      for (const child of Object.values(item)) {
        if (typeof child === 'string') {
          const known = byName[child.trim().toLowerCase()];
          if (known) add(known);
        }
      }
      Object.values(item).forEach(scan);
    }
    scan(value);
    return records;
  }

  function extractFeedWaiverBid(message) {
    const value = findFeedValueByKeys(message?.attachment, ['waiver_bid', 'waiverBid']);
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function enrichFeedMessages(messages, identityMap = {}, players = {}) {
    return (messages || []).map(message => {
      const manager = resolveFeedManager(message, identityMap);
      const playerRecords = extractFeedPlayerRecords(message?.attachment, players);
      const transactionId = extractFeedTransactionId(message);
      const waiverBid = extractFeedWaiverBid(message);
      const direct = typeof message?.text === 'string' ? message.text.trim() : '';
      let displayText = feedDisplayText({...message, display_text: ''});

      if (/claimed off waivers/i.test(direct) && playerRecords.length) {
        const details = [`Added ${playerRecords[0].name}`];
        if (playerRecords[1]) details.push(`Dropped ${playerRecords[1].name}`);
        if (waiverBid != null) details.push(`$${waiverBid} FAAB`);
        displayText = `Waiver claim: ${details.join(' | ')}`;
      } else {
        const rosterMove = direct.match(/^.+?\s+made a roster move:\s*(.+)$/i);
        if (rosterMove) displayText = rosterMove[1].trim();
        const freeAgentMove = direct.match(/^.+?\s+made a free agent move\.?$/i);
        if (freeAgentMove && playerRecords.length) {
          displayText = `Free agent move: ${playerRecords.map(item => item.name).join(', ')}`;
        }
        const tradeBlock = direct.match(/^.+?\s+put a player on the trade block:\s*(.+)$/i);
        if (tradeBlock) displayText = `Put on trade block: ${tradeBlock[1].trim()}`;
      }

      return {
        ...message,
        manager_name: manager,
        display_text: displayText,
        feed_transaction_id: transactionId,
        feed_player_records: playerRecords,
        feed_waiver_bid: waiverBid,
      };
    });
  }

  function feedTransactionCandidate(message, {teams = {}, players = {}, currentOwnership = {}} = {}) {
    if (message?.kind !== 'system') return null;
    const direct = typeof message?.text === 'string' ? message.text.trim() : '';
    const records = message?.feed_player_records || extractFeedPlayerRecords(message?.attachment, players);
    const manager = message?.manager_name || message?.author_name || 'Unknown team';
    const managerRosterEntry = Object.entries(teams || {}).find(([, value]) => value === manager);
    const rosterId = managerRosterEntry ? Number(managerRosterEntry[0]) : null;
    const waiverBid = message?.feed_waiver_bid ?? extractFeedWaiverBid(message);
    let type = String(findFeedValueByKeys(message?.attachment, ['type']) || 'free_agent').toLowerCase();
    let added = [];
    let dropped = [];

    if (/claimed off waivers/i.test(direct)) {
      type = 'waiver';
      if (records[0]) added = [records[0]];
      if (records[1]) dropped = [records[1]];
    } else if (/made a roster move/i.test(direct)) {
      const detail = direct.split(/made a roster move:\s*/i)[1] || '';
      const hasAdded = /\badded\b/i.test(detail);
      const hasDropped = /\bdropped\b/i.test(detail);
      if (hasAdded && hasDropped) {
        if (records[0]) added = [records[0]];
        if (records[1]) dropped = [records[1]];
      } else if (hasAdded) {
        if (records[0]) added = [records[0]];
      } else if (hasDropped) {
        if (records[0]) dropped = [records[0]];
      } else {
        return null;
      }
    } else {
      return null;
    }

    if (!added.length && !dropped.length) return null;
    const pieces = [manager];
    if (added.length) pieces.push(`adds ${added.map(item => item.name).join(', ')}`);
    const dropChecks = dropped.map(item => {
      if (item.player_id) return buildDropCheck(item.player_id, rosterId, teams, players, currentOwnership);
      return {
        player_id: null,
        player_name: item.name,
        availability: 'unrostered_api',
        current_owner_roster_id: null,
        current_owner_name: null,
        label: `${item.name} [UNROSTERED PER PUBLIC API — VERIFY IN SLEEPER]`,
      };
    });
    if (dropChecks.length) pieces.push(`drop event: ${dropChecks.map(item => item.label).join(', ')}`);
    if (type === 'waiver' && waiverBid != null) pieces.push(`for $${waiverBid} FAAB`);
    pieces.push('[recovered from Sleeper feed]');

    return {
      transaction_id: message?.feed_transaction_id || extractFeedTransactionId(message) || `feed:${message?.message_id || message?.created_ms}`,
      type,
      created_ms: Number(message?.created_ms || 0),
      roster_ids: rosterId == null ? [] : [rosterId],
      summary: pieces.join(' — '),
      drop_checks: dropChecks,
      raw: null,
      source: 'sleeper_feed',
      feed_player_names: [...added, ...dropped].map(item => item.name),
      feed_manager_name: manager,
    };
  }

  function mergeTransactionsWithFeed(publicTransactions, feedMessages, context = {}) {
    const merged = [...(publicTransactions || [])];
    const ids = new Set(merged.map(tx => tx?.transaction_id).filter(Boolean).map(String));

    for (const message of feedMessages || []) {
      const candidate = feedTransactionCandidate(message, context);
      if (!candidate) continue;
      if (candidate.transaction_id && ids.has(String(candidate.transaction_id))) continue;

      const duplicate = merged.some(tx => {
        const delta = Math.abs(Number(tx?.created_ms || 0) - Number(candidate.created_ms || 0));
        if (delta > 3 * 60 * 1000) return false;
        const summary = String(tx?.summary || '').toLowerCase();
        if (candidate.feed_manager_name && !summary.includes(String(candidate.feed_manager_name).toLowerCase())) return false;
        const names = candidate.feed_player_names || [];
        return names.length > 0 && names.some(name => summary.includes(String(name).toLowerCase()));
      });
      if (duplicate) continue;

      merged.push(candidate);
      if (candidate.transaction_id) ids.add(String(candidate.transaction_id));
    }

    return merged.sort((a, b) => Number(b.created_ms || 0) - Number(a.created_ms || 0));
  }

  function classifyFeedKind(message) {
    const text = feedDisplayText(message).toLowerCase();
    if (/trade block|on the block|put .* on the trade block/.test(text)) return 'trade_block';
    if (
      /\bi['’]?ll trade\b/.test(text) ||
      /\btrade with anyone\b/.test(text) ||
      /\bpre[- ]?draft trades?\b/.test(text) ||
      /\btrades?\b.*\b(goin|going|anyone|open|looking)\b/.test(text) ||
      /\bsend me\b.*\b(pick|picks|1st|2nd|3rd|4th|draft)\b/.test(text) ||
      /\boffer\b.*\bfor\b/.test(text) ||
      /\bavailable\b.*\b(trade|pick|picks)\b/.test(text)
    ) return 'trade_interest';
    if (message?.author_is_bot || /made a (free agent|waiver|trade) move/.test(text)) return 'system';
    if (text === '[message with no text]') return 'other';
    return 'chat';
  }

  function normalizeFeedMessage(message) {
    const createdMs = Number(message?.created || 0);
    const normalized = {
      message_id: String(message?.message_id || ''),
      created_ms: Number.isFinite(createdMs) ? createdMs : 0,
      author_id: message?.author_id == null ? null : String(message.author_id),
      author_name: message?.author_display_name || message?.author_real_name || (message?.author_is_bot ? 'Sleeper' : 'Unknown'),
      author_is_bot: Boolean(message?.author_is_bot),
      text: typeof message?.text === 'string' ? message.text : '',
      text_map: sanitizeFeedValue(message?.text_map ?? null),
      attachment: sanitizeFeedValue(message?.attachment ?? null),
      reactions: Array.isArray(message?.reactions) ? message.reactions : [],
      pinned: Boolean(message?.pinned),
      kind: 'other',
      raw: null,
    };
    normalized.kind = classifyFeedKind(normalized);
    return normalized;
  }

  function filterRecentFeed(messages, nowMs, hours) {
    const cutoff = Number(nowMs) - Number(hours) * 60 * 60 * 1000;
    return (messages || [])
      .map(normalizeFeedMessage)
      .filter(message => message.created_ms >= cutoff && message.created_ms <= Number(nowMs))
      .sort((a, b) => a.created_ms - b.created_ms);
  }


  function extractMarketSignals(messages) {
    return (messages || [])
      .filter(message => ['trade_interest', 'trade_block'].includes(message.kind))
      .map(message => ({
        message_id: message.message_id,
        created_ms: message.created_ms,
        manager: message.manager_name || message.author_name,
        signal_type: message.kind,
        source_text: message.display_text || feedDisplayText(message),
      }));
  }


  function playerBrief(playerId, players) {
    const p = players?.[String(playerId)] || {};
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || String(playerId);
    return {
      player_id: String(playerId),
      name,
      position: p.position || '',
      team: p.team || '',
      label: `${name}${p.position ? ` (${p.position}${p.team ? `, ${p.team}` : ''})` : ''}`,
    };
  }

  function buildRosterView(roster, teamNameValue, players) {
    const taxi = new Set((roster?.taxi || []).map(String));
    const reserve = new Set((roster?.reserve || []).map(String));
    const all = new Set([
      ...(roster?.players || []),
      ...(roster?.starters || []),
      ...(roster?.taxi || []),
      ...(roster?.reserve || []),
    ].map(String));
    const activeIds = [...all].filter(pid => !taxi.has(pid) && !reserve.has(pid));
    return {
      roster_id: Number(roster?.roster_id || 0),
      team_name: teamNameValue,
      active: activeIds.map(pid => playerBrief(pid, players)),
      taxi: [...taxi].map(pid => playerBrief(pid, players)),
      reserve: [...reserve].map(pid => playerBrief(pid, players)),
    };
  }

  function formatRosterView(view) {
    const labels = values => values.length ? values.map(x => x.label || x.name).join(', ') : 'none';
    return `${view.team_name} — Active: ${labels(view.active)}; Taxi: ${labels(view.taxi)}; Reserve / IR: ${labels(view.reserve)}`;
  }

  return {
    ordinal,
    pickLabel,
    playerName,
    teamName,
    transactionTimeMs,
    filterRecent,
    buildCurrentOwnership,
    buildWaiverWatch,
    normalizeTransaction,
    buildSnapshotText,
    feedDisplayText,
    buildFeedIdentityMap,
    resolveFeedManager,
    enrichFeedMessages,
    mergeTransactionsWithFeed,
    sanitizeFeedValue,
    normalizeFeedMessage,
    filterRecentFeed,
    extractMarketSignals,
    buildRosterView,
    formatRosterView,
  };
});
