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

  function normalizeTransaction(tx, teams, players) {
    const type = String(tx?.type || 'transaction');
    const rosterIds = (tx?.roster_ids || []).map(Number);
    const adds = tx?.adds || {};
    const drops = tx?.drops || {};
    const picks = tx?.draft_picks || [];
    const budgets = tx?.waiver_budget || [];
    const settings = tx?.settings || {};
    let summary = '';

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
      const dropped = Object.keys(drops).map(pid => playerName(pid, players));
      if (added.length) pieces.push(`adds ${added.join(', ')}`);
      if (dropped.length) pieces.push(`drops ${dropped.join(', ')}`);
      if (settings.waiver_bid != null) pieces.push(`for $${Number(settings.waiver_bid)} FAAB`);
      summary = pieces.join(' — ');
    }

    return {
      transaction_id: tx?.transaction_id || null,
      type,
      created_ms: transactionTimeMs(tx),
      roster_ids: rosterIds,
      summary,
      raw: tx,
    };
  }

  function buildSnapshotText({leagueName, hours, refreshedIso, transactions, rosterSummaries}) {
    const lines = [
      'CLOUD DYNASTY LEAGUE ACTIVITY SNAPSHOT',
      `League: ${leagueName || 'Cloud Dynasty League'}`,
      `Window: last ${hours} hours`,
      `Refreshed: ${refreshedIso}`,
      `Transactions: ${(transactions || []).length}`,
      '',
      'League activity:',
    ];

    if (!transactions?.length) {
      lines.push('- none');
    } else {
      transactions.forEach((tx, idx) => {
        const d = new Date(tx.created_ms);
        const stamp = Number.isFinite(d.getTime())
          ? d.toLocaleString('en-US', {
              timeZone: 'America/New_York',
              month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit',
            })
          : 'unknown time';
        lines.push(`${idx + 1}. [${stamp} ET] ${String(tx.type).toUpperCase()} — ${tx.summary}`);
      });
    }

    lines.push('', 'Current involved rosters:');
    if (!rosterSummaries?.length) lines.push('- none');
    else rosterSummaries.forEach(line => lines.push(`- ${line}`));

    return lines.join('\n');
  }

  return {
    ordinal,
    pickLabel,
    playerName,
    teamName,
    transactionTimeMs,
    filterRecent,
    normalizeTransaction,
    buildSnapshotText,
  };
});
