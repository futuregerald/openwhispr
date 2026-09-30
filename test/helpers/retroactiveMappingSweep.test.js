const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      shell: {},
      dialog: {},
      clipboard: {},
      systemPreferences: {},
      nativeTheme: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

// 2-D unit vectors: with the profile at [1, 0], the cosine similarity of
// [s, sqrt(1-s^2)] is exactly s. Asserted below rather than assumed, so these
// fixtures break loudly if cosineSimilarity ever changes.
const PROFILE_VECTOR = Float32Array.from([1, 0]);
const embeddingBuffer = (score) =>
  Buffer.from(Float32Array.from([score, Math.sqrt(1 - score * score)]).buffer);

test("the fixtures really do produce the similarities they claim", () => {
  const speakerEmbeddings = require("../../src/helpers/speakerEmbeddings");
  for (const score of [0.95, 0.94, 0.9, 0.75, 0.7, 0.66, 0.4, 0.2]) {
    const buf = embeddingBuffer(score);
    const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    assert.ok(
      Math.abs(speakerEmbeddings.cosineSimilarity(PROFILE_VECTOR, vec) - score) < 1e-6,
      `fixture for ${score} does not score ${score}`
    );
  }
});

const profile = {
  id: 7,
  display_name: "Dana",
  embedding: Buffer.from(PROFILE_VECTOR.buffer),
};

/**
 * @param scores   similarity each speaker in the note should score
 * @param segments transcript segments, defaulting to one per speaker
 */
function sweepHarness({ scores, segments = null, rawTranscript = null, existing = [] } = {}) {
  const noteId = 1;
  const mappingWrites = [];
  const noteUpdates = [];

  const speakers = scores.map((score, i) => ({
    speaker_id: `speaker_${i}`,
    embedding: embeddingBuffer(score),
  }));

  const transcript =
    rawTranscript ??
    JSON.stringify(segments ?? speakers.map((s) => ({ speaker: s.speaker_id, text: "hello" })));

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      getNotesWithUnmappedSpeakers: () => [noteId],
      getNoteSpeakerEmbeddings: () => speakers,
      getSpeakerMappings: () => existing,
      setSpeakerMapping: (id, speakerId, profileId, displayName, provenance) => {
        mappingWrites.push({ id, speakerId, profileId, displayName, provenance });
        return { success: true };
      },
      getNote: () => ({ id: noteId, transcript }),
      updateNote: (id, updates) => {
        noteUpdates.push(updates);
        return { success: true };
      },
    },
  });

  const run = async () => {
    handlers._retroactiveMapping(profile);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { handlers, run, mappingWrites, noteUpdates, noteId };
}

const writtenSegments = (h) =>
  h.noteUpdates.length > 0 ? JSON.parse(h.noteUpdates[h.noteUpdates.length - 1].transcript) : [];

test("a note whose speakers are all ambiguous gets no mapping row", async () => {
  const h = sweepHarness({ scores: [0.95, 0.94] });
  await h.run();
  assert.equal(h.mappingWrites.length, 0, "an ambiguous note was given a confirmed name");
});

test("a note with a clear winner gets exactly one mapping row, tagged auto", async () => {
  const h = sweepHarness({ scores: [0.9, 0.2] });
  await h.run();
  assert.equal(h.mappingWrites.length, 1, "one profile claimed more than one speaker");
  const [write] = h.mappingWrites;
  assert.equal(write.speakerId, "speaker_0");
  assert.equal(write.provenance.origin, "auto");
  assert.ok(write.provenance.confidence > 0.65);
});

// The defect #79 is actually about: there is no `break`, so before this change
// every speaker clearing 0.6 was mapped to the same profile.
test("three clearing speakers still produce at most one mapping", async () => {
  const h = sweepHarness({ scores: [0.9, 0.75, 0.7] });
  await h.run();
  assert.equal(h.mappingWrites.length, 1, "the pre-fix behaviour mapped all three");
  assert.equal(h.mappingWrites[0].speakerId, "speaker_0");
});

test("an ambiguous note is written as a suggestion on its segments", async () => {
  const h = sweepHarness({ scores: [0.95, 0.94] });
  await h.run();
  const segments = writtenSegments(h);
  const suggested = segments.filter((s) => s.suggestedName === "Dana");
  assert.ok(suggested.length > 0, "the user is never shown the guess");
  assert.equal(suggested[0].speakerStatus, "suggested");
  assert.equal(suggested[0].suggestedProfileId, 7);
  assert.ok(
    !segments.some((s) => s.speakerStatus === "confirmed"),
    "an ambiguous guess was confirmed"
  );
});

test("a confident match renames only the matched speaker's unnamed segments", async () => {
  const h = sweepHarness({
    scores: [0.9, 0.2],
    segments: [
      { speaker: "speaker_0", text: "a" },
      { speaker: "speaker_1", text: "b" },
      { speaker: "speaker_0", text: "c", speakerName: "Already Named" },
    ],
  });
  await h.run();
  const segments = writtenSegments(h);
  assert.equal(segments[0].speakerName, "Dana");
  assert.equal(segments[1].speakerName, undefined, "an unmatched speaker was renamed");
  assert.equal(segments[2].speakerName, "Already Named", "an existing name was overwritten");
});

// The inverted check this replaces force-wrote exactly the locked segments it
// was meant to protect.
//
// Asserting on the absence of a WRITE, not on the segment's name:
// applyConfirmedSpeaker already self-protects against a locked segment
// (speakerAssignmentPolicy.js:39), so a name assertion holds whether or not the
// skip exists and the test would pass with the skip deleted. What the skip
// uniquely controls is whether `changed` is set, and so whether the note is
// rewritten at all.
test("a locked segment causes no write at all", async () => {
  const h = sweepHarness({
    scores: [0.9, 0.2],
    segments: [{ speaker: "speaker_0", text: "a", speakerLocked: true, speakerLockSource: "user" }],
  });
  await h.run();
  assert.equal(h.noteUpdates.length, 0, "a locked segment triggered a pointless transcript write");
  assert.equal(h.mappingWrites.length, 1, "the mapping row itself should still be written");
});

test("nothing is written when no speaker is close enough", async () => {
  const h = sweepHarness({ scores: [0.4, 0.2] });
  await h.run();
  assert.equal(h.mappingWrites.length, 0);
  assert.equal(h.noteUpdates.length, 0, "a note with no match was rewritten anyway");
});

test("an already-mapped speaker is not reconsidered", async () => {
  const h = sweepHarness({
    scores: [0.9, 0.2],
    existing: [{ speaker_id: "speaker_0", display_name: "Someone Else" }],
  });
  await h.run();
  assert.ok(
    h.mappingWrites.every((w) => w.speakerId !== "speaker_0"),
    "an existing mapping was overwritten"
  );
});

// The CRITICAL this branch originally shipped with. The sweep re-runs on every
// set-speaker-mapping and attach-speaker-email, so the FIRST sweep suggesting
// correctly was not enough: scoring only the unmapped speakers removed the
// already-mapped one from the field, leaving no runner-up to fail the margin
// against, and the second sweep promoted a 0.94 near-tie to a confident match.
test("a second sweep does not hand the profile a second speaker in the same note", async () => {
  const h = sweepHarness({
    scores: [0.95, 0.94],
    existing: [{ speaker_id: "speaker_0", profile_id: 7, display_name: "Dana", origin: "auto" }],
  });
  await h.run();
  assert.equal(h.mappingWrites.length, 0, "Dana was put on two different people in one meeting");
  assert.equal(h.noteUpdates.length, 0);
});

test("a profile already holding a speaker in the note takes no further speaker", async () => {
  const h = sweepHarness({
    scores: [0.2, 0.99],
    existing: [{ speaker_id: "speaker_0", profile_id: 7, display_name: "Dana", origin: "manual" }],
  });
  await h.run();
  assert.equal(h.mappingWrites.length, 0, "one profile claimed two speakers across sweeps");
});

// With the mapped speaker excluded from scoring, this note had a single
// candidate, no runner-up, and so no margin at all -- the exact "no margin"
// policy #79 was filed about, reintroduced.
test("a speaker left over beside a mapped one is not confirmed on threshold alone", async () => {
  const h = sweepHarness({
    scores: [0.9, 0.66],
    existing: [
      { speaker_id: "speaker_0", profile_id: 3, display_name: "Someone", origin: "manual" },
    ],
  });
  await h.run();
  assert.equal(h.mappingWrites.length, 0, "confirmed at 0.66 with nothing to compare against");
});

test("a suggestion does not replace a name the user can already see", async () => {
  const h = sweepHarness({
    scores: [0.95, 0.94],
    segments: [
      {
        speaker: "speaker_0",
        text: "a",
        speakerName: "Fabian",
        speakerIsPlaceholder: false,
        speakerStatus: "confirmed",
      },
    ],
  });
  await h.run();
  assert.equal(h.noteUpdates.length, 0, "Fabian was hidden behind a suggestion for Dana");
});

test("a placeholder name may still be suggested over", async () => {
  const h = sweepHarness({
    scores: [0.95, 0.94],
    segments: [
      { speaker: "speaker_0", text: "a", speakerName: "Speaker 1", speakerIsPlaceholder: true },
    ],
  });
  await h.run();
  assert.equal(writtenSegments(h)[0].suggestedName, "Dana");
});

// Every sweep used to rewrite every ambiguous note, bumping updated_at and
// re-shredding the segment index forever, because `changed` was unconditional.
test("re-sweeping an already-suggested note writes nothing", async () => {
  const h = sweepHarness({
    scores: [0.95, 0.94],
    segments: [
      {
        speaker: "speaker_0",
        text: "a",
        suggestedName: "Dana",
        suggestedProfileId: 7,
        speakerStatus: "suggested",
      },
    ],
  });
  await h.run();
  assert.equal(h.noteUpdates.length, 0, "an unchanged note was rewritten anyway");
});
