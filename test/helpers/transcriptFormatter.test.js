const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSpeaker,
  buildSpeakerMappings,
  formatMd,
  formatTxt,
} = require("../../src/helpers/transcriptFormatter.js");
const { i18nMain } = require("../../src/helpers/i18nMain.js");

test("resolveSpeaker prefers a real speakerName over a mapping", () => {
  const seg = { speaker: "speaker_2", speakerName: "Jay", speakerIsPlaceholder: false };
  assert.equal(resolveSpeaker(seg, { speaker_2: "Someone Else" }), "Jay");
});

test("resolveSpeaker ignores a placeholder speakerName and uses the mapping", () => {
  const seg = { speaker: "speaker_2", speakerName: "Speaker 3", speakerIsPlaceholder: true };
  assert.equal(resolveSpeaker(seg, { speaker_2: "Jay" }), "Jay");
});

test("resolveSpeaker falls back to the mapping when no speakerName is stored", () => {
  const seg = { speaker: "speaker_7" };
  assert.equal(resolveSpeaker(seg, { speaker_7: "Molly" }), "Molly");
});

test("resolveSpeaker renders the mic speaker as You", () => {
  assert.equal(resolveSpeaker({ speaker: "you" }, {}), i18nMain.t("transcript.speaker.you"));
});

test("resolveSpeaker renders an unmapped id one-indexed, not as a raw id", () => {
  assert.equal(resolveSpeaker({ speaker: "speaker_2" }, {}), "Speaker 3");
  assert.equal(resolveSpeaker({ speaker: "speaker_0" }, {}), "Speaker 1");
});

test("resolveSpeaker labels an unattributed system turn rather than leaving it bare", () => {
  const label = resolveSpeaker({ source: "system" }, {});
  assert.equal(label, i18nMain.t("transcript.speaker.others"));
});

test("resolveSpeaker labels an unattributed mic turn", () => {
  assert.equal(resolveSpeaker({ source: "mic" }, {}), i18nMain.t("transcript.speaker.you"));
});

test("buildSpeakerMappings turns the stored rows into a speaker_id -> name map", () => {
  const db = {
    getSpeakerMappings: () => [
      { speaker_id: "speaker_0", display_name: "Anton" },
      { speaker_id: "speaker_2", display_name: "Jay" },
    ],
  };
  assert.deepEqual(buildSpeakerMappings(db, 70), { speaker_0: "Anton", speaker_2: "Jay" });
});

test("buildSpeakerMappings tolerates a database without the accessor", () => {
  assert.deepEqual(buildSpeakerMappings({}, 70), {});
  assert.deepEqual(buildSpeakerMappings(null, 70), {});
});

// The stored shape is CalendarAttendee (displayName), and a reader keyed on `name`
// silently produced an empty list that suppressed the line entirely rather than
// rendering a blank one -- which is why no existing test caught it.
test("formatMd renders participants from the stored displayName shape", () => {
  const note = {
    title: "Team Sync",
    created_at: "2026-09-21T16:29:36Z",
    participants: JSON.stringify([
      { email: "molly@example.com", displayName: "Molly", responseStatus: "accepted", self: false },
      { email: "mike@example.com", displayName: "Mike", responseStatus: "accepted", self: false },
    ]),
  };
  const md = formatMd(note, [{ speaker: "speaker_0", text: "Hi.", timestamp: 0 }], {});
  assert.match(md, /\*\*Participants:\*\* Molly, Mike/);
});

// The email local part rather than the whole address: formatMd is written automatically into
// the note-files mirror, which users point at synced folders, so a full address would put a
// third party's contact details there without the user ever typing them.
test("formatMd falls back to name then the email local part when displayName is null", () => {
  const note = {
    title: "Team Sync",
    created_at: "2026-09-21T16:29:36Z",
    participants: JSON.stringify([
      { email: "molly@example.com", displayName: null },
      { email: "legacy@example.com", name: "Legacy Shape" },
      { email: "bare@example.com", displayName: null },
    ]),
  };
  const md = formatMd(note, [{ speaker: "speaker_0", text: "Hi.", timestamp: 0 }], {});
  assert.match(md, /\*\*Participants:\*\* molly, Legacy Shape, bare/);
  assert.doesNotMatch(md, /@example\.com/, "a full address must not reach the mirror file");
});

test("formatTxt renders the same participants line as formatMd", () => {
  const note = {
    title: "Team Sync",
    created_at: "2026-09-21T16:29:36Z",
    participants: JSON.stringify([{ email: "molly@example.com", displayName: "Molly" }]),
  };
  const txt = formatTxt(note, [{ speaker: "speaker_0", text: "Hi.", timestamp: 0 }], {});
  assert.match(txt, /Participants: Molly/);
});

test("a null entry does not silently empty the whole participants list", () => {
  const note = {
    title: "Team Sync",
    created_at: "2026-09-21T16:29:36Z",
    participants: JSON.stringify([null, { email: "molly@example.com", displayName: "Molly" }]),
  };
  const md = formatMd(note, [{ speaker: "speaker_0", text: "Hi.", timestamp: 0 }], {});
  assert.match(
    md,
    /\*\*Participants:\*\* Molly/,
    "without optional chaining the map throws, catch {} swallows it, and the line vanishes"
  );
});

test("formatMd omits the participants line when there are genuinely none", () => {
  const note = { title: "Team Sync", created_at: "2026-09-21T16:29:36Z", participants: "[]" };
  const md = formatMd(note, [{ speaker: "speaker_0", text: "Hi.", timestamp: 0 }], {});
  assert.doesNotMatch(md, /Participants:/);
});

test("formatMd still renders mapped names, so export output is pinned", () => {
  const note = { title: "Team Sync", created_at: "2026-09-21T16:29:36Z", participants: "[]" };
  const segments = [{ speaker: "speaker_2", text: "Morning all.", timestamp: 12 }];
  const md = formatMd(note, segments, { speaker_2: "Jay" });
  assert.match(md, /\*\*Jay\*\*/);
  assert.match(md, /Morning all\./);
});
