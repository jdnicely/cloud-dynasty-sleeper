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
        availability: 'available',
        current_owner_roster_id: null,
        current_owner_name: null,
        label: `${player} [CONFIRMED AVAILABLE]`,
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

    const checks = (transactions || []).flatMap(tx => tx.drop_checks || []);
    const available = checks.filter(x => x.availability === 'available');
    const mismatches = checks.filter(x => x.availability !== 'available');

    lines.push('', 'Confirmed available from drop events:');
    if (!available.length) lines.push('- none');
    else available.forEach(x => lines.push(`- ${x.player_name}`));

    lines.push('', 'Ownership mismatches / re-rostered players:');
    if (!mismatches.length) lines.push('- none');
    else mismatches.forEach(x => {
      const wording = x.availability === 'rostered_same'
        ? `still on ${x.current_owner_name}`
        : `currently on ${x.current_owner_name}`;
      lines.push(`- ${x.player_name} — ${wording}`);
    });

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
    buildCurrentOwnership,
    normalizeTransaction,
    buildSnapshotText,
  };
});
