export function selectPreferredDraft(drafts) {
  if (!Array.isArray(drafts) || drafts.length === 0) return null;
  const newestFirst = [...drafts].sort((a, b) => {
    const aTime = Number(a?.start_time ?? a?.created ?? 0);
    const bTime = Number(b?.start_time ?? b?.created ?? 0);
    return bTime - aTime;
  });
  return (
    newestFirst.find((draft) => draft?.status === 'drafting') ??
    newestFirst.find((draft) => draft?.status === 'pre_draft') ??
    newestFirst[0]
  );
}

export function overallPickNumber(round, slot, teams, type = 'linear') {
  const r = Number(round);
  const s = Number(slot);
  const t = Number(teams);
  if (![r, s, t].every(Number.isFinite) || r < 1 || s < 1 || t < 1 || s > t) return null;
  const offset = (r - 1) * t;
  if (type === 'snake' && r % 2 === 0) return offset + (t - s + 1);
  return offset + s;
}

export function buildEffectiveSlotToRosterId(draft, rosters = []) {
  const result = {};
  const assignedRosterIds = new Set();
  const assignedSlots = new Set();
  const rosterByUserId = new Map();

  for (const roster of rosters ?? []) {
    const rosterId = Number(roster?.roster_id);
    if (!Number.isFinite(rosterId)) continue;
    const userIds = [roster?.owner_id, ...(roster?.co_owners ?? [])].filter((value) => value != null && value !== '');
    for (const userId of userIds) rosterByUserId.set(String(userId), rosterId);
  }

  for (const [userId, rawSlot] of Object.entries(draft?.draft_order ?? {})) {
    const slot = Number(rawSlot);
    const rosterId = rosterByUserId.get(String(userId));
    if (!Number.isFinite(slot) || !Number.isFinite(rosterId)) continue;
    result[String(slot)] = rosterId;
    assignedSlots.add(slot);
    assignedRosterIds.add(rosterId);
  }

  for (const [rawSlot, rawRosterId] of Object.entries(draft?.slot_to_roster_id ?? {})) {
    const slot = Number(rawSlot);
    const rosterId = Number(rawRosterId);
    if (!Number.isFinite(slot) || !Number.isFinite(rosterId)) continue;
    if (assignedSlots.has(slot) || assignedRosterIds.has(rosterId)) continue;
    result[String(slot)] = rosterId;
    assignedSlots.add(slot);
    assignedRosterIds.add(rosterId);
  }

  return result;
}

export function resolvePickOwner(round, slot, draft, tradedPicks = [], rosters = []) {
  const slotMap = buildEffectiveSlotToRosterId(draft, rosters);
  const originalOwner = Number(slotMap[String(slot)] ?? slotMap[slot]);
  if (!Number.isFinite(originalOwner)) return null;
  const trade = (tradedPicks ?? []).find(
    (item) => Number(item?.round) === Number(round) && Number(item?.roster_id) === originalOwner,
  );
  return Number(trade?.owner_id ?? originalOwner);
}

export function resolveDraftPickRosterId(pick, draft, rosters = [], tradedPicks = []) {
  const directRosterId = Number(pick?.roster_id);
  if (Number.isFinite(directRosterId) && directRosterId > 0) return directRosterId;

  const pickedBy = String(pick?.picked_by ?? '').trim();
  if (pickedBy) {
    const roster = (rosters ?? []).find((item) => {
      if (String(item?.owner_id ?? '') === pickedBy) return true;
      return (item?.co_owners ?? []).some((userId) => String(userId) === pickedBy);
    });
    const rosterId = Number(roster?.roster_id);
    if (Number.isFinite(rosterId) && rosterId > 0) return rosterId;
  }

  if (pick?.round != null && pick?.draft_slot != null) {
    return resolvePickOwner(pick.round, pick.draft_slot, draft, tradedPicks, rosters);
  }
  return null;
}

export function buildUpcomingPicks(draft, picks = [], tradedPicks = [], rosterId, rosters = []) {
  const teams = Number(draft?.settings?.teams ?? Object.keys(draft?.slot_to_roster_id ?? {}).length);
  const rounds = Number(draft?.settings?.rounds ?? 0);
  const wantedRosterId = Number(rosterId);
  if (!Number.isFinite(teams) || teams < 1 || !Number.isFinite(rounds) || rounds < 1 || !Number.isFinite(wantedRosterId)) {
    return [];
  }

  const filled = new Set(
    (picks ?? [])
      .filter((pick) => pick?.round != null && pick?.draft_slot != null)
      .map((pick) => `${Number(pick.round)}:${Number(pick.draft_slot)}`),
  );

  const result = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (let slot = 1; slot <= teams; slot += 1) {
      if (filled.has(`${round}:${slot}`)) continue;
      const ownerRosterId = resolvePickOwner(round, slot, draft, tradedPicks, rosters);
      if (ownerRosterId !== wantedRosterId) continue;
      result.push({
        pickNo: overallPickNumber(round, slot, teams, draft?.type),
        round,
        slot,
        ownerRosterId,
      });
    }
  }
  return result.sort((a, b) => (a.pickNo ?? Infinity) - (b.pickNo ?? Infinity));
}

export function formatPickLabel(round, slot) {
  return `${Number(round)}.${String(Number(slot)).padStart(2, '0')}`;
}

export function playerLabel(pick) {
  const meta = pick?.metadata ?? {};
  const name = [meta.first_name, meta.last_name].filter(Boolean).join(' ').trim() || pick?.player_id || 'Unknown player';
  const details = [meta.position, meta.team].filter(Boolean).join(', ');
  return details ? `${name} (${details})` : name;
}

export function rosterLabel(rosterId, rosters = [], users = []) {
  if (rosterId == null) return 'Unassigned';
  const numericId = Number(rosterId);
  if (!Number.isFinite(numericId) || numericId < 1) return 'Unassigned';
  const roster = (rosters ?? []).find((item) => Number(item?.roster_id) === numericId);
  const user = (users ?? []).find((item) => String(item?.user_id) === String(roster?.owner_id ?? ''));
  const teamName = user?.metadata?.team_name || user?.display_name || user?.username;
  return teamName ? `${teamName} (Roster ${numericId})` : `Roster ${numericId}`;
}

export function nextOverallPick(picks = []) {
  const numbers = (picks ?? []).map((pick) => Number(pick?.pick_no)).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}


export function chooseDraftId({ directDraftId = null, manualDraftId = 'auto', drafts = [] } = {}) {
  const direct = String(directDraftId ?? '').trim();
  if (direct) return direct;
  const manual = String(manualDraftId ?? 'auto');
  if (manual !== 'auto' && (drafts ?? []).some((draft) => String(draft?.draft_id) === manual)) return manual;
  const preferred = selectPreferredDraft(drafts ?? []);
  return preferred?.draft_id != null ? String(preferred.draft_id) : null;
}

export function buildChatSnapshot(state) {
  const draft = state?.draft ?? {};
  const picks = [...(state?.picks ?? [])].sort((a, b) => Number(a?.pick_no ?? 0) - Number(b?.pick_no ?? 0));
  const tradedPicks = state?.tradedPicks ?? [];
  const users = state?.users ?? [];
  const rosters = state?.rosters ?? [];
  const selectedRosterId = Number(state?.selectedRosterId);
  const draftName = draft?.metadata?.name || `Draft ${draft?.draft_id ?? ''}`.trim();
  const upcoming = Number.isFinite(selectedRosterId)
    ? buildUpcomingPicks(draft, picks, tradedPicks, selectedRosterId, rosters)
    : [];

  const lines = [
    'CLOUD DYNASTY DRAFT SNAPSHOT',
    `Draft: ${draftName}`,
    `Status: ${draft?.status ?? 'unknown'}`,
    `Next overall pick: ${nextOverallPick(picks)}`,
  ];

  if (state?.refreshedAt) lines.push(`Refreshed: ${state.refreshedAt}`);

  if (Number.isFinite(selectedRosterId)) {
    lines.push(`My roster: ${rosterLabel(selectedRosterId, rosters, users)}`);
    lines.push('Upcoming owned picks:');
    if (upcoming.length) {
      for (const pick of upcoming.slice(0, 12)) {
        lines.push(`- ${formatPickLabel(pick.round, pick.slot)} (overall ${pick.pickNo})`);
      }
    } else {
      lines.push('- none remaining');
    }
  }

  lines.push('Drafted players:');
  if (!picks.length) {
    lines.push('- none yet');
  } else {
    for (const pick of picks) {
      const label = formatPickLabel(pick?.round, pick?.draft_slot);
      const pickRosterId = resolveDraftPickRosterId(pick, draft, rosters, tradedPicks);
      const owner = pickRosterId != null ? rosterLabel(pickRosterId, rosters, users) : 'Unknown roster';
      lines.push(`${label} — ${playerLabel(pick)} — ${owner}`);
    }
  }

  return lines.join('\n');
}
