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


export function isDetachedLeagueMock(draft) {
  return Boolean(
    draft &&
    !draft.league_id &&
    draft?.metadata?.league_id &&
    String(draft?.metadata?.type ?? '') === 'league_mock'
  );
}

export function selectReferenceLeagueDraft(mockDraft, leagueDrafts = []) {
  const candidates = (Array.isArray(leagueDrafts) ? leagueDrafts : []).filter(
    (draft) => String(draft?.draft_id ?? '') !== String(mockDraft?.draft_id ?? ''),
  );
  if (!candidates.length) return null;
  const season = String(mockDraft?.season ?? '').trim();
  const sameSeason = season
    ? candidates.filter((draft) => String(draft?.season ?? '').trim() === season)
    : [];
  return selectPreferredDraft(sameSeason.length ? sameSeason : candidates);
}

export function applyLeagueMockReferenceDraft(mockDraft, referenceDraft) {
  if (!isDetachedLeagueMock(mockDraft) || !referenceDraft) return mockDraft;
  const referenceSlotMap = referenceDraft?.slot_to_roster_id ?? {};
  if (!Object.keys(referenceSlotMap).length) return mockDraft;
  return {
    ...mockDraft,
    slot_to_roster_id: { ...referenceSlotMap },
    reference_draft_id: String(referenceDraft?.draft_id ?? ''),
  };
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
  const rosterByUserId = new Map();

  // Sleeper's slot_to_roster_id is the authoritative mapping from a draft
  // column to the original league roster. League mocks may expose a
  // draft_order that reflects mock participants/placeholders instead of the
  // league's actual roster order, so it must never override this map.
  for (const [rawSlot, rawRosterId] of Object.entries(draft?.slot_to_roster_id ?? {})) {
    const slot = Number(rawSlot);
    const rosterId = Number(rawRosterId);
    if (!Number.isFinite(slot) || !Number.isFinite(rosterId)) continue;
    result[String(slot)] = rosterId;
    assignedRosterIds.add(rosterId);
  }

  for (const roster of rosters ?? []) {
    const rosterId = Number(roster?.roster_id);
    if (!Number.isFinite(rosterId)) continue;
    const userIds = [roster?.owner_id, ...(roster?.co_owners ?? [])].filter((value) => value != null && value !== '');
    for (const userId of userIds) rosterByUserId.set(String(userId), rosterId);
  }

  // Only fill genuinely missing slot-map entries from draft_order.
  for (const [userId, rawSlot] of Object.entries(draft?.draft_order ?? {})) {
    const slot = Number(rawSlot);
    const rosterId = rosterByUserId.get(String(userId));
    if (!Number.isFinite(slot) || !Number.isFinite(rosterId)) continue;
    if (result[String(slot)] != null || assignedRosterIds.has(rosterId)) continue;
    result[String(slot)] = rosterId;
    assignedRosterIds.add(rosterId);
  }

  return result;
}

export function selectEffectiveTradedPicks(draftTradedPicks = [], leagueTradedPicks = [], season = null) {
  const draftTrades = Array.isArray(draftTradedPicks) ? draftTradedPicks : [];
  if (draftTrades.length) return draftTrades;

  const leagueTrades = Array.isArray(leagueTradedPicks) ? leagueTradedPicks : [];
  const wantedSeason = String(season ?? '').trim();
  if (!wantedSeason) return leagueTrades;
  return leagueTrades.filter((item) => String(item?.season ?? '') === wantedSeason);
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
  // A detached league mock that has been enriched with a reference draft must
  // attribute the franchise by the real league draft column, not by the user
  // who clicked the mock pick. Sleeper's picked_by value can represent a mock
  // participant and does not reliably identify the franchise owning that slot.
  if (draft?.reference_draft_id && pick?.round != null && pick?.draft_slot != null) {
    const referencedOwner = resolvePickOwner(pick.round, pick.draft_slot, draft, tradedPicks, rosters);
    if (Number.isFinite(referencedOwner) && referencedOwner > 0) return referencedOwner;
  }

  // Outside detached league mocks, picked_by remains useful when a real league
  // user made the pick and Sleeper omitted a roster_id.
  const pickedBy = String(pick?.picked_by ?? '').trim();
  if (pickedBy) {
    const roster = (rosters ?? []).find((item) => {
      if (String(item?.owner_id ?? '') === pickedBy) return true;
      return (item?.co_owners ?? []).some((userId) => String(userId) === pickedBy);
    });
    const rosterId = Number(roster?.roster_id);
    if (Number.isFinite(rosterId) && rosterId > 0) return rosterId;
  }

  // Resolve the pick's draft column through the authoritative slot map (and
  // traded-pick owner) before trusting the raw roster_id.
  if (pick?.round != null && pick?.draft_slot != null) {
    const resolved = resolvePickOwner(pick.round, pick.draft_slot, draft, tradedPicks, rosters);
    if (Number.isFinite(resolved) && resolved > 0) return resolved;
  }

  const directRosterId = Number(pick?.roster_id);
  if (Number.isFinite(directRosterId) && directRosterId > 0) return directRosterId;
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
