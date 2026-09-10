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
      'MARKET INTELLIGENCE',
    ];

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
          const author = message.author_name || (message.author_is_bot ? 'Sleeper' : 'Unknown');
          lines.push(`[${formatEasternStamp(message.created_ms)} ET] ${author}: ${feedDisplayText(message)}${formatReactionSummary(message.reactions)}`);
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
    const direct = typeof message?.text === 'string' ? message.text.trim() : '';
    const mapped = stringifyCompact(message?.text_map).replace(/\s+/g, ' ').trim();
    const attached = stringifyCompact(message?.attachment).replace(/\s+/g, ' ').trim();

    if (direct) {
      if (message?.author_is_bot) {
        const extras = [mapped, attached]
          .filter(Boolean)
          .filter(value => !direct.includes(value));
        if (extras.length) return `${direct} — ${extras.join(' — ')}`;
      }
      return direct;
    }
    if (mapped) return mapped;
    return attached || '[message with no text]';
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
        manager: message.author_name,
        signal_type: message.kind,
        source_text: feedDisplayText(message),
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
    normalizeTransaction,
    buildSnapshotText,
    feedDisplayText,
    sanitizeFeedValue,
    normalizeFeedMessage,
    filterRecentFeed,
    extractMarketSignals,
    buildRosterView,
    formatRosterView,
  };
});
