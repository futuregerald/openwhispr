const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/recordingTarget.js");

test("a note with transcript segments has a recording", async () => {
  const { noteHasRecording } = await load();
  assert.equal(noteHasRecording({ transcript: JSON.stringify([{ text: "hi" }]) }), true);
});

test("a note with a plain-text transcript has a recording", async () => {
  const { noteHasRecording } = await load();
  assert.equal(noteHasRecording({ transcript: "Alice: hello" }), true);
});

test("a note with no transcript content has no recording", async () => {
  const { noteHasRecording } = await load();
  for (const transcript of ["[]", "", "   ", null, undefined]) {
    assert.equal(noteHasRecording({ transcript }), false, JSON.stringify(transcript));
  }
});

test("a note with only saved audio has a recording", async () => {
  const { noteHasRecording } = await load();
  assert.equal(noteHasRecording({ transcript: "", mic_audio_path: "/a/mic.wav" }), true);
  assert.equal(noteHasRecording({ transcript: "[]", system_audio_path: "/a/sys.wav" }), true);
});

test("a missing note has no recording", async () => {
  const { noteHasRecording } = await load();
  assert.equal(noteHasRecording(null), false);
});

test("a continued note keeps the title, type and folder and adds the suffix", async () => {
  const { continuedNoteFields } = await load();
  const fields = continuedNoteFields(
    { title: "Standup", note_type: "meeting", folder_id: 4 },
    "(continued)"
  );
  assert.deepEqual(fields, {
    title: "Standup (continued)",
    noteType: "meeting",
    folderId: 4,
    carried: {},
  });
});

test("an untitled source falls back to a default title", async () => {
  const { continuedNoteFields } = await load();
  assert.equal(continuedNoteFields({ title: "" }, "(continued)").title, "New note (continued)");
  assert.equal(
    continuedNoteFields({ title: null }, "(continued)", "Untitled note").title,
    "Untitled note (continued)"
  );
});

test("only non-null calendar, participants and meeting type are carried", async () => {
  const { continuedNoteFields } = await load();
  const { carried } = continuedNoteFields(
    {
      title: "x",
      calendar_event_id: "evt",
      participants: null,
      meeting_type_id: 3,
    },
    "(continued)"
  );
  assert.deepEqual(carried, { calendar_event_id: "evt", meeting_type_id: 3 });
});

test("the speaker settings travel with the continued note, including diarization switched off", async () => {
  const { continuedNoteFields } = await load();
  const { carried } = continuedNoteFields(
    { title: "x", diarization_enabled: 0, expected_speaker_count: 2 },
    "(continued)"
  );
  assert.deepEqual(carried, { diarization_enabled: 0, expected_speaker_count: 2 });
});
