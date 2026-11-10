const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

function handlersForNote(note) {
  const h = Object.create(IPCHandlers.prototype);
  Object.assign(h, {
    databaseManager: {
      getNote: () => (note ? { id: 5, ...note } : null),
      getGoogleAccounts: () => [{ email: "me@example.com" }],
    },
  });
  return h;
}

const withParticipants = (participants, extra = {}) =>
  handlersForNote({
    participants: participants == null ? null : JSON.stringify(participants),
    ...extra,
  });

const expectation = (h, { noteId = 5, engine = "fluidaudio" } = {}) =>
  h._resolveSpeakerExpectation({ noteId, engine });

const THREE_OTHERS = [
  { displayName: "Me", email: "me@example.com" },
  { displayName: "Self", self: true },
  { displayName: "A" },
  { displayName: "B" },
  { displayName: "C" },
];

test("three other participants bound the engine at four speakers", () => {
  assert.deepEqual(expectation(withParticipants(THREE_OTHERS)), { maxSpeakers: 4 });
});

test("a single other participant sets no bound: it may be a group alias", () => {
  assert.deepEqual(expectation(withParticipants([{ displayName: "A", email: "team@x.com" }])), {
    maxSpeakers: null,
  });
});

test("no participants means no bound", () => {
  assert.deepEqual(expectation(withParticipants(null)), { maxSpeakers: null });
  assert.deepEqual(expectation(withParticipants([])), { maxSpeakers: null });
});

test("only self participants means no bound", () => {
  assert.deepEqual(expectation(withParticipants([{ displayName: "Me", self: true }])), {
    maxSpeakers: null,
  });
});

test("no note means no bound", () => {
  assert.deepEqual(expectation(withParticipants(THREE_OTHERS), { noteId: null }), {
    maxSpeakers: null,
  });
});

test("the count the user set for the note wins over the calendar", () => {
  const h = withParticipants(THREE_OTHERS, { expected_speaker_count: 7 });
  assert.deepEqual(expectation(h), { maxSpeakers: 7, userSetSpeakers: true });
});

test("the user's count applies even without a calendar", () => {
  assert.deepEqual(expectation(handlersForNote({ expected_speaker_count: 2 })), {
    maxSpeakers: 2,
    userSetSpeakers: true,
  });
});

test("sherpa gets no calendar bound", () => {
  assert.deepEqual(expectation(withParticipants(THREE_OTHERS), { engine: "sherpa" }), {
    maxSpeakers: null,
  });
});

function diarizationHarness({ note, engine = "fluidaudio" }) {
  const diarizeCalls = [];
  const capCalls = [];
  const h = Object.create(IPCHandlers.prototype);
  Object.assign(h, {
    speakerDiarizationEnabled: true,
    diarizationManager: {
      isAvailable: () => true,
      getDiarizationEngine: () => engine,
      convertRawPcmToWav: async () => "/tmp/ow-expectation-test.wav",
      diarize: async (_wav, options) => {
        diarizeCalls.push(options);
        return [
          { speaker: "raw_a", start: 0, end: 30 },
          { speaker: "raw_b", start: 30, end: 31 },
          { speaker: "raw_c", start: 40, end: 41 },
          { speaker: "raw_d", start: 50, end: 51 },
          { speaker: "raw_e", start: 60, end: 61 },
        ];
      },
      capSpeakerClusters: (segments, cap) => {
        capCalls.push(cap);
        return segments;
      },
      mergeWithTranscript: (transcript) => transcript,
    },
    speakerEmbeddings: { isAvailable: () => false },
    databaseManager: {
      getNote: () => ({ id: 5, ...note }),
      getGoogleAccounts: () => [],
      getSpeakerProfiles: () => [],
      getSpeakerMappings: () => [],
    },
    _persistDiarizedTranscript: (_noteId, segments) => segments,
    _enqueuePostCallPipeline: () => {},
  });
  const run = () =>
    h._startOrSkipDiarization(
      "session-1",
      "/tmp/ow-expectation-test.pcm",
      0,
      [{ id: "t1", text: "hi", source: "system", timestamp: 0 }],
      null,
      null,
      null,
      5
    );
  return { run, diarizeCalls, capCalls };
}

test("a three-person calendar reaches FluidAudio as maxSpeakers 4, with no size folding", async () => {
  const h = diarizationHarness({ note: { participants: JSON.stringify(THREE_OTHERS.slice(2)) } });
  await h.run();
  assert.deepEqual(h.diarizeCalls, [{ maxSpeakers: 4 }]);
  assert.deepEqual(h.capCalls, [], "clusters were folded by size");
});

test("the user's count reaches the engine instead of the calendar's", async () => {
  const h = diarizationHarness({
    note: { participants: JSON.stringify(THREE_OTHERS.slice(2)), expected_speaker_count: 6 },
  });
  await h.run();
  assert.deepEqual(h.diarizeCalls, [{ maxSpeakers: 6, userSetSpeakers: true }]);
  assert.deepEqual(h.capCalls, []);
});

test("on sherpa a calendar neither bounds nor folds the speakers", async () => {
  const h = diarizationHarness({
    note: { participants: JSON.stringify(THREE_OTHERS.slice(2)) },
    engine: "sherpa",
  });
  await h.run();
  assert.deepEqual(h.diarizeCalls, [{}]);
  assert.deepEqual(h.capCalls, []);
});

test("a 1:1 calendar neither bounds nor folds the speakers", async () => {
  const h = diarizationHarness({ note: { participants: JSON.stringify([{ displayName: "A" }]) } });
  await h.run();
  assert.deepEqual(h.diarizeCalls, [{}]);
  assert.deepEqual(h.capCalls, []);
});
