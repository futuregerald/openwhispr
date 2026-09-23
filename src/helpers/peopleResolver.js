const { buildNoteSearchQuery } = require("./noteSearch");
const { resolveDateRange } = require("./searchDateRange");

const TIER_WEIGHTS = {
  email: 1,
  "full name": 0.9,
  "name prefix": 0.75,
  "first name only": 0.55,
  "partial name": 0.4,
};

const AMBIGUOUS_TIERS = new Set(["first name only", "partial name"]);
const RUNNER_UP_MARGIN = 0.2;
const MAX_ACTIVITY_TEXT_CHARS = 300;
const MAX_ATTENDED_SCAN = 500;
const MAX_EVIDENCE_WEIGHT = 0.12;
const MAX_SPOKEN_NAME_TERMS = 50;

function normalizeName(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase();
}

function tokenize(value) {
  return normalizeName(value).split(" ").filter(Boolean);
}

class IdentityBuilder {
  constructor() {
    this.parent = new Map();
    this.nodes = new Map();
  }

  _ensure(key) {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      this.nodes.set(key, {
        keys: new Set([key]),
        names: new Map(),
        emails: new Set(),
        sources: new Set(),
        spokenSegments: 0,
        notesAttended: new Set(),
        lastSeen: null,
      });
    }
    return key;
  }

  find(key) {
    this._ensure(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;

    const target = this.nodes.get(rootA);
    const merged = this.nodes.get(rootB);
    for (const key of merged.keys) target.keys.add(key);
    for (const [name, count] of merged.names) {
      target.names.set(name, (target.names.get(name) || 0) + count);
    }
    for (const email of merged.emails) target.emails.add(email);
    for (const source of merged.sources) target.sources.add(source);
    target.spokenSegments += merged.spokenSegments;
    for (const noteId of merged.notesAttended) target.notesAttended.add(noteId);
    if (merged.lastSeen && (!target.lastSeen || merged.lastSeen > target.lastSeen)) {
      target.lastSeen = merged.lastSeen;
    }

    this.parent.set(rootB, rootA);
    this.nodes.delete(rootB);
    return rootA;
  }

  node(key) {
    return this.nodes.get(this.find(key));
  }

  addName(key, name, weight = 1) {
    if (!name) return;
    const node = this.node(key);
    node.names.set(name, (node.names.get(name) || 0) + weight);
  }

  addSource(key, source) {
    this.node(key).sources.add(source);
  }

  identities() {
    return [...this.nodes.values()];
  }
}

function collectIdentities(db) {
  const builder = new IdentityBuilder();

  for (const row of db.prepare("SELECT email, display_name FROM contacts").all()) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    const key = `email:${email}`;
    builder.addSource(key, "contacts");
    builder.node(key).emails.add(email);
    builder.addName(key, row.display_name || email);
  }

  for (const row of db
    .prepare("SELECT id, display_name, email, sample_count FROM speaker_profiles")
    .all()) {
    const key = `profile:${row.id}`;
    builder.addSource(key, "speaker_profiles");
    builder.addName(key, row.display_name);
    const email = normalizeEmail(row.email);
    if (email) {
      builder.node(key).emails.add(email);
      builder.union(key, `email:${email}`);
      builder.addSource(key, "speaker_profiles");
    }
  }

  for (const row of db
    .prepare("SELECT note_id, speaker_id, profile_id, display_name FROM speaker_mappings")
    .all()) {
    if (row.profile_id == null) continue;
    const key = `profile:${row.profile_id}`;
    builder.addName(key, row.display_name);
    builder.addSource(key, "speaker_profiles");
  }

  const spoken = db
    .prepare(
      `SELECT s.speaker_name AS name, COUNT(*) AS segments, MAX(n.created_at) AS last_seen
       FROM transcript_segments s
       JOIN notes n ON n.id = s.note_id
       WHERE s.speaker_name IS NOT NULL AND n.deleted_at IS NULL
       GROUP BY s.speaker_name`
    )
    .all();

  const profileKeyByName = new Map();
  for (const identity of builder.identities()) {
    for (const name of identity.names.keys()) {
      const normalized = normalizeName(name);
      if (normalized && !profileKeyByName.has(normalized)) {
        profileKeyByName.set(normalized, [...identity.keys][0]);
      }
    }
  }

  for (const row of spoken) {
    const normalized = normalizeName(row.name);
    if (!normalized) continue;
    const existing = profileKeyByName.get(normalized);
    const key = existing || `name:${normalized}`;
    builder.addSource(key, "transcripts");
    builder.addName(key, row.name, 2);
    const node = builder.node(key);
    node.spokenSegments += row.segments;
    if (row.last_seen && (!node.lastSeen || row.last_seen > node.lastSeen)) {
      node.lastSeen = row.last_seen;
    }
  }

  const attendeeRows = db
    .prepare(
      "SELECT id, participants, created_at FROM notes WHERE participants IS NOT NULL AND deleted_at IS NULL"
    )
    .all();

  for (const row of attendeeRows) {
    let attendees = [];
    try {
      attendees = JSON.parse(row.participants || "[]");
    } catch {
      attendees = [];
    }
    if (!Array.isArray(attendees)) continue;
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee?.email);
      const name = attendee?.displayName || attendee?.name || email;
      if (!email && !name) continue;
      const key = email ? `email:${email}` : `name:${normalizeName(name)}`;
      builder.addSource(key, "participants");
      if (email) builder.node(key).emails.add(email);
      builder.addName(key, name);
      builder.node(key).notesAttended.add(row.id);
      const node = builder.node(key);
      if (row.created_at && (!node.lastSeen || row.created_at > node.lastSeen)) {
        node.lastSeen = row.created_at;
      }
    }
  }

  return builder.identities().map((identity) => {
    const names = [...identity.names.entries()].sort((a, b) => b[1] - a[1]);
    const displayName = names.length ? names[0][0] : [...identity.emails][0] || "Unknown";
    const emails = [...identity.emails].sort();
    const personId = emails.length
      ? `email:${emails[0]}`
      : `name:${normalizeName(displayName)}`;

    return {
      person_id: personId,
      display_name: displayName,
      all_names: names.map(([name]) => name),
      emails,
      sources: [...identity.sources].sort(),
      spoken_segments: identity.spokenSegments,
      notes_attended: identity.notesAttended.size,
      last_seen: identity.lastSeen,
      keys: [...identity.keys],
    };
  });
}

function matchTier(queryTokens, queryNormalized, candidate) {
  for (const name of candidate.all_names) {
    const candidateNormalized = normalizeName(name);
    if (!candidateNormalized) continue;
    const candidateTokens = candidateNormalized.split(" ").filter(Boolean);

    if (candidateNormalized === queryNormalized) return "full name";

    if (
      queryTokens.length > 1 &&
      queryTokens.length <= candidateTokens.length &&
      queryTokens.every((token, index) => candidateTokens[index]?.startsWith(token))
    ) {
      return "name prefix";
    }

    if (queryTokens.length === 1 && candidateTokens.includes(queryTokens[0])) {
      return "first name only";
    }

    if (candidateNormalized.includes(queryNormalized)) return "partial name";
  }
  return null;
}

function evidenceWeight(candidate) {
  const mentions =
    candidate.spoken_segments + candidate.notes_attended + candidate.sources.length;
  return Math.min(Math.log10(1 + mentions) / 10, MAX_EVIDENCE_WEIGHT);
}

function resolve(db, name, limit = 5, precollected = null) {
  const queryNormalized = normalizeName(name);
  const queryTokens = tokenize(name);
  const identities = precollected || collectIdentities(db);

  if (!queryNormalized) return { person: null, ambiguous: false, reason: null, candidates: [] };

  const emailQuery = String(name || "").includes("@");
  let scored = [];

  if (emailQuery) {
    const wanted = normalizeEmail(name);
    scored = identities
      .filter((identity) => identity.emails.includes(wanted))
      .map((identity) => ({ ...identity, match_reason: "email", score: TIER_WEIGHTS.email }));
  } else {
    for (const identity of identities) {
      const tier = matchTier(queryTokens, queryNormalized, identity);
      if (!tier) continue;
      scored.push({
        ...identity,
        match_reason: tier,
        score: Number((TIER_WEIGHTS[tier] + evidenceWeight(identity)).toFixed(4)),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, limit).map(({ keys, all_names: _names, ...rest }) => rest);

  if (candidates.length === 0) {
    return { person: null, ambiguous: false, reason: null, candidates: [] };
  }

  const best = candidates[0];
  const runnerUp = candidates[1];
  const sharesTier = scored.filter((item) => item.match_reason === best.match_reason).length;
  const closeRunnerUp = runnerUp && best.score - runnerUp.score < best.score * RUNNER_UP_MARGIN;
  const ambiguous = AMBIGUOUS_TIERS.has(best.match_reason) || Boolean(closeRunnerUp);

  let reason = null;
  if (AMBIGUOUS_TIERS.has(best.match_reason)) {
    reason = `${best.match_reason} match; ${sharesTier} ${sharesTier === 1 ? "person" : "people"} share it`;
  } else if (closeRunnerUp) {
    reason = "more than one person scores within 20% of the best match";
  }

  return { person: best, ambiguous, reason, candidates };
}

function findIdentity(db, { personId = null, name = null }) {
  const identities = collectIdentities(db);

  if (personId) {
    const match = identities.find((identity) => identity.person_id === personId);
    if (match) return match;
  }
  if (name) {
    const resolved = resolve(db, name, 1, identities);
    if (resolved.person) {
      return identities.find((identity) => identity.person_id === resolved.person.person_id);
    }
  }
  return null;
}

function capText(text) {
  const value = text ?? "";
  return value.length > MAX_ACTIVITY_TEXT_CHARS
    ? value.slice(0, MAX_ACTIVITY_TEXT_CHARS)
    : value;
}

function activity(db, options = {}) {
  const {
    personId = null,
    name = null,
    kinds = ["spoken", "mentioned", "attended"],
    since = null,
    until = null,
    limit = 20,
  } = options;

  const identity = findIdentity(db, { personId, name });
  const empty = { person: null, spoken: [], mentioned: [], attended: [] };
  if (!identity) return empty;

  const { from, to } = resolveDateRange(since, until);
  const wanted = new Set(kinds);
  const result = {
    person: {
      person_id: identity.person_id,
      display_name: identity.display_name,
      emails: identity.emails,
      sources: identity.sources,
    },
    spoken: [],
    mentioned: [],
    attended: [],
  };

  const dateClause = [];
  const dateParams = [];
  if (from) {
    dateClause.push("datetime(n.created_at) >= datetime(?)");
    dateParams.push(from.sql);
  }
  if (to) {
    dateClause.push("datetime(n.created_at) < datetime(?)");
    dateParams.push(to.sql);
  }
  const dateWhere = dateClause.length ? ` AND ${dateClause.join(" AND ")}` : "";

  if (wanted.has("spoken") && identity.all_names.length) {
    const spokenNames = identity.all_names.slice(0, MAX_SPOKEN_NAME_TERMS);
    const placeholders = spokenNames.map(() => "?").join(", ");
    result.spoken = db
      .prepare(
        `SELECT s.note_id, s.seq, s.speaker_name, s.text, s.offset_ms, s.started_at_ms,
                s.timestamp_kind, n.title AS note_title
         FROM transcript_segments s
         JOIN notes n ON n.id = s.note_id
         WHERE s.speaker_name IN (${placeholders}) AND n.deleted_at IS NULL${dateWhere}
         ORDER BY n.created_at DESC, s.seq ASC
         LIMIT ?`
      )
      .all(...spokenNames, ...dateParams, limit)
      .map((row) => ({ ...row, text: capText(row.text) }));
  }

  if (wanted.has("mentioned")) {
    const ftsQuery = buildNoteSearchQuery(identity.display_name);
    if (ftsQuery) {
      result.mentioned = db
        .prepare(
          `SELECT n.id AS note_id, n.title AS note_title, n.created_at
           FROM notes n
           JOIN notes_fts ON notes_fts.rowid = n.id
           WHERE notes_fts MATCH ? AND n.deleted_at IS NULL${dateWhere}
           ORDER BY notes_fts.rank
           LIMIT ?`
        )
        .all(ftsQuery, ...dateParams, limit);
    }
  }

  if (wanted.has("attended") && identity.emails.length) {
    const rows = db
      .prepare(
        `SELECT n.id AS note_id, n.title AS note_title, n.participants, n.created_at
         FROM notes n
         WHERE n.participants IS NOT NULL AND n.deleted_at IS NULL${dateWhere}
         ORDER BY n.created_at DESC
         LIMIT ?`
      )
      .all(...dateParams, MAX_ATTENDED_SCAN);

    const emails = new Set(identity.emails);
    result.attended = rows
      .filter((row) => {
        let attendees = [];
        try {
          attendees = JSON.parse(row.participants || "[]");
        } catch {
          return false;
        }
        return (
          Array.isArray(attendees) &&
          attendees.some((attendee) => emails.has(normalizeEmail(attendee?.email)))
        );
      })
      .slice(0, limit)
      .map(({ participants: _participants, ...rest }) => rest);
  }

  return result;
}

function list(db, options = {}) {
  const { sort = "mentions", limit = 25 } = options;
  const identities = collectIdentities(db).map(({ keys: _keys, all_names: _names, ...rest }) => rest);

  const comparators = {
    mentions: (a, b) =>
      b.spoken_segments + b.notes_attended - (a.spoken_segments + a.notes_attended),
    recent: (a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")),
    name: (a, b) => a.display_name.localeCompare(b.display_name),
  };

  const comparator = Object.prototype.hasOwnProperty.call(comparators, sort)
    ? comparators[sort]
    : comparators.mentions;
  return identities.sort(comparator).slice(0, limit);
}

module.exports = { resolve, activity, list, normalizeName, normalizeEmail };
