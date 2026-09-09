const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/diarizationPayloadGuard.ts");

const SESSION = "session-abc";

test("accepts a payload whose note matches the open note", async () => {
  const { classifyDiarizationPayload } = await load();

  assert.deepEqual(
    classifyDiarizationPayload(
      { sessionId: SESSION, noteId: 36, segments: [] },
      { sessionId: SESSION, noteId: 36 }
    ),
    { accepted: true, reason: null }
  );
});

test("refuses a payload addressed to a different note, even in the expected session", async () => {
  const { classifyDiarizationPayload } = await load();

  assert.deepEqual(
    classifyDiarizationPayload(
      { sessionId: SESSION, noteId: 36, segments: [] },
      { sessionId: SESSION, noteId: 30 }
    ),
    { accepted: false, reason: "note-mismatch" }
  );
});

test("accepts a payload carrying no note, so a pre-upgrade main process is not silently dropped", async () => {
  const { classifyDiarizationPayload } = await load();

  assert.deepEqual(
    classifyDiarizationPayload({ sessionId: SESSION, segments: [] }, { sessionId: SESSION, noteId: 30 }),
    { accepted: true, reason: null }
  );
  assert.deepEqual(
    classifyDiarizationPayload(
      { sessionId: SESSION, noteId: null, segments: [] },
      { sessionId: SESSION, noteId: 30 }
    ),
    { accepted: true, reason: null }
  );
});

test("refuses when no diarization session is expected", async () => {
  const { classifyDiarizationPayload } = await load();

  assert.deepEqual(
    classifyDiarizationPayload({ sessionId: SESSION, noteId: 30 }, { sessionId: null, noteId: 30 }),
    { accepted: false, reason: "no-session" }
  );
});

test("refuses a payload from another diarization session", async () => {
  const { classifyDiarizationPayload } = await load();

  assert.deepEqual(
    classifyDiarizationPayload(
      { sessionId: "session-other", noteId: 30 },
      { sessionId: SESSION, noteId: 30 }
    ),
    { accepted: false, reason: "session-mismatch" }
  );
  assert.deepEqual(classifyDiarizationPayload(undefined, { sessionId: SESSION, noteId: 30 }), {
    accepted: false,
    reason: "session-mismatch",
  });
});
