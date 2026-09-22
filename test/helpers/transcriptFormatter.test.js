const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSpeaker,
  buildSpeakerMappings,
  formatMd,
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

test("formatMd still renders mapped names, so export output is pinned", () => {
  const note = { title: "Team Sync", created_at: "2026-09-21T16:29:36Z", participants: "[]" };
  const segments = [{ speaker: "speaker_2", text: "Morning all.", timestamp: 12 }];
  const md = formatMd(note, segments, { speaker_2: "Jay" });
  assert.match(md, /\*\*Jay\*\*/);
  assert.match(md, /Morning all\./);
});
