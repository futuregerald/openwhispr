// @ts-check

/** @typedef {import("./detectWeldedSessions.js").WeldedSession} WeldedSession */

/**
 * @typedef {object} SplitGroup
 * @property {number} sessionIndex index into `report.sessions` of the SELECTED session this
 * group is built around
 * @property {boolean} isRetained the earliest group, which keeps the original note's id
 * @property {number[]} indices ORIGINAL-array indices this group owns, ascending
 * @property {object[]} segments copies of those segments, re-based so the group starts at 0
 * @property {number} startsAt the group's first timestamp in the ORIGINAL time base, which is
 * the constant subtracted to re-base it
 * @property {number[]} foldedFrom session indices that were not selected and folded in here
 */

/**
 * @typedef {object} SplitPlan
 * @property {boolean} ok
 * @property {"unusable" | "unassigned-segments" | "nothing-selected" | "selection-mismatch"} [reason]
 * @property {SplitGroup[]} [groups] ascending by time; the first is the retained note
 */

/**
 * Distance from a point in time to a session's span. Zero when the point falls inside it.
 * @param {number} at
 * @param {WeldedSession} session
 */
const distanceToSession = (at, session) => {
  if (at < session.startsAt) return session.startsAt - at;
  if (at > session.endsAt) return at - session.endsAt;
  return 0;
};

/**
 * Decide which notes a welded transcript becomes.
 *
 * Sessions the user selected each become their own note. Sessions they did not select are
 * folded into the nearest selected session by time — never dropped — so the segment count is
 * preserved under every selection.
 *
 * Refuses rather than guessing whenever the result could lose a segment: an unusable report,
 * a report with unassigned segments (a note mixing timestamp units has some in a discarded
 * time base), an empty selection, or a selection that does not match the sessions.
 *
 * @param {readonly object[]} segments the note's stored transcript segments
 * @param {{ usable: boolean, sessions: WeldedSession[], unassigned: number[] }} report from `detectSessions`
 * @param {readonly boolean[]} selection parallel to `report.sessions`; true means "its own note"
 * @returns {SplitPlan}
 */
export const planSplit = (segments, report, selection) => {
  if (!report?.usable) return { ok: false, reason: "unusable" };
  if (report.unassigned?.length) return { ok: false, reason: "unassigned-segments" };

  const sessions = report.sessions ?? [];
  if (!Array.isArray(selection) || selection.length !== sessions.length) {
    return { ok: false, reason: "selection-mismatch" };
  }

  const selectedIndices = sessions.map((_, i) => i).filter((i) => selection[i]);
  if (selectedIndices.length === 0) return { ok: false, reason: "nothing-selected" };

  /** @type {Map<number, { sessionIndex: number, indices: number[], foldedFrom: number[] }>} */
  const bySelected = new Map(
    selectedIndices.map((i) => [i, { sessionIndex: i, indices: [], foldedFrom: [] }])
  );

  for (let i = 0; i < sessions.length; i += 1) {
    // A session folds into itself when selected; otherwise into whichever selected session it
    // is nearest to. Ties go to the earlier one, because selectedIndices ascends and the
    // comparison is strict.
    let host = selectedIndices[0];
    if (selection[i]) {
      host = i;
    } else {
      let best = Infinity;
      for (const candidate of selectedIndices) {
        const gap = distanceToSession(sessions[i].startsAt, sessions[candidate]);
        if (gap < best) {
          best = gap;
          host = candidate;
        }
      }
    }
    const group = bySelected.get(host);
    group.indices.push(...sessions[i].indices);
    if (!selection[i]) group.foldedFrom.push(i);
  }

  const groups = selectedIndices.map((sessionIndex) => {
    const group = bySelected.get(sessionIndex);
    const indices = [...group.indices].sort((a, b) => a - b);
    const stamps = indices
      .map((index) => segments[index]?.timestamp)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    const startsAt = stamps.length ? Math.min(...stamps) : 0;
    return {
      sessionIndex,
      isRetained: false,
      indices,
      startsAt,
      foldedFrom: group.foldedFrom,
      segments: indices.map((index) => {
        const original = segments[index];
        const timestamp = original?.timestamp;
        return typeof timestamp === "number" && Number.isFinite(timestamp)
          ? { ...original, timestamp: timestamp - startsAt }
          : { ...original };
      }),
    };
  });

  groups.sort((a, b) => a.startsAt - b.startsAt);
  if (groups.length > 0) groups[0].isRetained = true;

  return { ok: true, groups };
};
