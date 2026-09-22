const test = require("node:test");
const assert = require("node:assert/strict");

function createMocks() {
  const events = [];
  const broadcast = (channel, payload) => events.push({ channel, ...payload });

  return {
    events,
    broadcast,
    databaseManager: {
      getNote: (id) => ({
        id,
        transcript: JSON.stringify([
          { text: "hello", speaker: "speaker_0", source: "system", timestamp: 0 },
        ]),
        system_audio_path: "/tmp/test.opus",
        mic_audio_path: null,
        meeting_type_id: null,
        audio_duration_seconds: 300,
      }),
      updateNote: () => ({ success: true }),
      getMeetingType: () => null,
      getMeetingTypes: () => [],
    },
    whisperManager: {
      transcribeLocalWhisper: async () => ({
        success: true,
        text: "hello world",
        segments: [{ start: 0, end: 2, text: "hello world" }],
      }),
      getModelPath: () => "/tmp/model.bin",
    },
    diarizationManager: {
      isAvailable: () => false,
    },
    inference: {
      processText: async (text, opts) => {
        if (opts.systemPrompt.includes("title")) return "Test Meeting Title";
        return "## Summary\nTest notes";
      },
    },
    convertToWav: async () => {},
  };
}

test("runs steps in order: retranscribe -> classify -> title -> notes", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const fs = require("fs");
  const origExists = fs.existsSync;
  const origReadFile = fs.readFileSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin") ? true : origExists(p);
  fs.readFileSync = (...args) =>
    typeof args[0] === "string" && args[0].includes("ow-retranscribe")
      ? Buffer.from("fake wav")
      : origReadFile(...args);
  fs.unlinkSync = (p) => { if (!String(p).includes("ow-retranscribe")) origUnlink(p); };

  // Set env vars for inference config
  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:running"));
    assert.ok(steps.includes("retranscribe:complete"));
    assert.ok(steps.includes("title:running"));
    assert.ok(steps.includes("title:complete"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));

    const retranscribeComplete = steps.indexOf("retranscribe:complete");
    const titleRunning = steps.indexOf("title:running");
    assert.ok(retranscribeComplete < titleRunning);
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origReadFile;
    fs.unlinkSync = origUnlink;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("stops pipeline on error and emits error status", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.whisperManager.transcribeLocalWhisper = async () => { throw new Error("model crashed"); };
  const fs = require("fs");
  const origExists = fs.existsSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin") ? true : origExists(p);
  fs.unlinkSync = () => {};

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:error"));
    assert.ok(!steps.includes("title:running"));
  } finally {
    fs.existsSync = origExists;
    fs.unlinkSync = origUnlink;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("skips retranscribe when no saved audio, proceeds to title", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:skipped"));
    assert.ok(steps.includes("title:running"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("uses meeting type template for note generation when set", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  let capturedPrompt = null;
  mocks.inference.processText = async (text, opts) => {
    if (opts.systemPrompt.includes("meeting notes assistant")) capturedPrompt = opts.systemPrompt;
    return "## Notes";
  };
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: 1,
  });
  mocks.databaseManager.getMeetingType = (id) => ({
    id,
    name: "Standup",
    template: "For each speaker: yesterday, today, blockers. End with Action Items.",
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);
    assert.ok(capturedPrompt.includes("yesterday, today, blockers"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("fromStep skips earlier steps", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1, { fromStep: "notes" });

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(!steps.includes("retranscribe:running"));
    assert.ok(!steps.includes("title:running"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("STEP_ORDER puts classify before title, so the title knows the type", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  // Access the module-level STEP_ORDER via a pipeline run and check step ordering
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [];

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // Classification has to be settled before the title is written, or the
    // title can never say "1:1 with Mike".
    const classifyComplete = steps.findIndex((s) => s.startsWith("classify:"));
    const titleRunning = steps.indexOf("title:running");
    const notesRunning = steps.indexOf("notes:running");

    assert.ok(classifyComplete > -1, "classify step should appear in pipeline");
    assert.ok(classifyComplete < titleRunning, "classify should come before title:running");
    assert.ok(titleRunning < notesRunning, "title should come before notes:running");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step skips when meeting_type_id already set", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: 3,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 3, name: "Retro", keyword_rules: '["retro"]' },
  ];
  mocks.databaseManager.getMeetingType = (id) => ({ id, name: "Retro", template: "Retro template" });
  let updateCalled = false;
  const origUpdate = mocks.databaseManager.updateNote;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) updateCalled = true;
    return origUpdate(id, updates);
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    // classify should complete but not update meeting_type_id
    assert.ok(!updateCalled, "should not update meeting_type_id when already set");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step uses LLM to detect meeting type", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "let's discuss yesterday's progress and today's plan" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 2, name: "Planning", keyword_rules: '["planning"]' },
  ];
  mocks.databaseManager.getMeetingType = () => null;

  let classifyUpdateId = null;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) classifyUpdateId = updates.meeting_type_id;
    return { success: true };
  };

  // LLM returns the id "1" for Standup
  mocks.inference.processText = async (text, opts) => {
    if (opts.systemPrompt.includes("meeting classifier")) return "1";
    if (opts.systemPrompt.includes("title")) return "Daily Standup";
    return "## Notes";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(classifyUpdateId, 1, "should set meeting_type_id to LLM-detected value");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step falls back to keyword matching when no LLM configured", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "let's do our standup. what did everyone do yesterday?" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 2, name: "Planning", keyword_rules: '["planning", "sprint"]' },
  ];

  let classifyUpdateId = null;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) classifyUpdateId = updates.meeting_type_id;
    return { success: true };
  };

  // No LLM configured
  delete process.env.NOTE_FORMATTING_PROVIDER;
  delete process.env.NOTE_FORMATTING_MODEL;

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(classifyUpdateId, 1, "should fall back to keyword match and set standup type");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step errors do not halt the pipeline", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello world" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  // getMeetingTypes throws to simulate a database error
  mocks.databaseManager.getMeetingTypes = () => { throw new Error("db connection lost"); };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // classify should error but notes should still run
    assert.ok(steps.includes("classify:error"), "classify should report error");
    assert.ok(steps.includes("notes:running"), "notes should still run after classify error");
    assert.ok(steps.includes("notes:complete"), "notes should complete after classify error");
    assert.ok(steps.includes("pipeline:complete"), "pipeline should complete");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("skips retranscribe when large model not downloaded yet", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  // whisperManager.getModelPath returns a path that doesn't exist on disk
  mocks.whisperManager.getModelPath = () => "/tmp/nonexistent-model-path.bin";
  const fs = require("fs");
  const origExists = fs.existsSync;
  // Audio file exists, but model file does not
  fs.existsSync = (p) => {
    if (p === "/tmp/test.opus") return true;
    if (p === "/tmp/nonexistent-model-path.bin") return false;
    return origExists(p);
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // The step has not run, so it must report pending and NOT complete: the drain queue
    // keys off this note staying pending until the model download finishes.
    assert.ok(steps.includes("retranscribe:running"));
    assert.ok(steps.includes("retranscribe:pending"));
    assert.ok(!steps.includes("retranscribe:complete"));
    assert.ok(!steps.some((s) => s === "retranscribe:error"));

    // Title and notes should still run using the existing transcript
    assert.ok(steps.includes("title:running"));
    assert.ok(steps.includes("title:complete"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));
    assert.ok(steps.includes("pipeline:complete"));
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a preserved re-transcription writes no transcript and is not marked pending", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  // Dual-source transcript with only one track on disk: rewriting it from the system
  // track alone would throw away everything the user said.
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([
      { text: "them", speaker: "speaker_0", source: "system", timestamp: 0 },
      { text: "me", speaker: "you", source: "mic", timestamp: 5 },
    ]),
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
  });
  const transcriptWrites = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.transcript !== undefined) transcriptWrites.push(updates.transcript);
    return { success: true };
  };

  const fs = require("fs");
  const origExists = fs.existsSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin" ? true : origExists(p));

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.deepEqual(transcriptWrites, [], "must not overwrite a transcript it cannot replace");

    const retranscribe = mocks.events.filter(
      (e) => e.channel === "post-call-pipeline-status" && e.step === "retranscribe"
    );
    const terminal = retranscribe.at(-1);
    assert.equal(terminal.status, "complete");
    assert.equal(terminal.preserved, true);
    assert.equal(terminal.reason, "incomplete-source-coverage");
    assert.ok(
      !retranscribe.some((e) => e.status === "pending"),
      "preserved must not leak into the pending-retranscription set"
    );
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a preserved re-transcription still runs the later steps on the kept transcript", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([
      { text: "the kept words", speaker: "speaker_0", source: "system", timestamp: 0 },
      { text: "and my half", speaker: "you", source: "mic", timestamp: 5 },
    ]),
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
  });
  const titleInputs = [];
  mocks.inference.processText = async (text, opts) => {
    // The notes prompt also mentions "title", so match the title prompt itself.
    if (opts.systemPrompt.startsWith("Generate a concise")) {
      titleInputs.push(text);
      return "Kept Title";
    }
    return "## Notes";
  };

  const fs = require("fs");
  const origExists = fs.existsSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin" ? true : origExists(p));

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(titleInputs.length, 1);
    assert.ok(
      titleInputs[0].includes("and my half"),
      "the kept transcript covers both sides, so it beats a system-only re-transcription"
    );
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// The tests above assert on broadcast status events. A step can emit
// "complete" without having written anything, so assert the actual writes too.
test("the title step writes the generated title to the note", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push({ id, updates });
    return { success: true };
  };

  // The shared mock keys off the prompt containing "title", which both the
  // title and notes prompts do. Distinguish by call order instead.
  let call = 0;
  mocks.inference.processText = async () => {
    call += 1;
    return call === 1 ? "Test Meeting Title" : "## Summary\nGenerated notes body";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1, { fromStep: "title" });

    const titleWrite = writes.find((w) => w.updates.title !== undefined);
    assert.ok(titleWrite, "the pipeline must persist a title, not merely report title:complete");
    assert.equal(titleWrite.updates.title, "Test Meeting Title");

    const notesWrite = writes.find((w) => w.updates.enhanced_content !== undefined);
    assert.ok(notesWrite, "the pipeline must persist generated notes");
    assert.match(notesWrite.updates.enhanced_content, /Generated notes body/);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// Regression: an unconfigured noteFormatting scope once shipped as a release
// that generated no titles and no notes, because _getInferenceConfig returns
// null and every AI step is skipped without surfacing an error.
test("no title or notes are written when noteFormatting is unconfigured", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push({ id, updates });
    return { success: true };
  };
  let inferenceCalls = 0;
  mocks.inference.processText = async () => {
    inferenceCalls += 1;
    return "should not be reached";
  };

  delete process.env.NOTE_FORMATTING_PROVIDER;
  delete process.env.NOTE_FORMATTING_MODEL;

  const manager = new PostCallPipelineManager({
    broadcast: mocks.broadcast,
    databaseManager: mocks.databaseManager,
    whisperManager: mocks.whisperManager,
    diarizationManager: mocks.diarizationManager,
    inference: mocks.inference,
    convertToWav: mocks.convertToWav,
  });

  await manager.run(1, { fromStep: "title" });

  assert.equal(inferenceCalls, 0, "no model should be called without a configured provider");
  assert.equal(
    writes.find((w) => w.updates.title !== undefined),
    undefined,
    "an unconfigured pipeline must not invent a title"
  );
});

// ── Long transcripts (1.17.0) ──────────────────────────────────────────────
//
// The notes step used to send `text.slice(0, 8000)` in a single call. On a local
// model that is a hard failure ("Prompt is too long ... budget of 1228"); on a
// cloud model it silently discarded everything past about 25 minutes of meeting.

const LONG_SEGMENTS = Array.from({ length: 400 }, (_, i) => ({
  text: `Segment ${i}: we discussed the quarterly rollout and agreed on the staffing plan.`,
  speaker: `speaker_${i % 3}`,
  source: "system",
  timestamp: i,
}));

function longTranscriptMocks(createMocks) {
  const mocks = createMocks();
  const transcript = JSON.stringify(LONG_SEGMENTS);
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript,
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
    audio_duration_seconds: 3600,
  });
  return mocks;
}

function recordingInference(mocks) {
  const calls = [];
  mocks.inference.processText = async (text, opts) => {
    calls.push({ text, opts });
    if (opts.systemPrompt?.includes("extracting source material")) return "DECISIONS: rollout agreed.";
    return "## Summary\nTest notes";
  };
  return calls;
}

test("a local model chunks a long transcript instead of failing on it", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => ({ contextSize: 8192, isGpuBackend: true }),
    });

    await manager.runSingleStep(1, "notes");

    const statuses = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status" && e.step === "notes")
      .map((e) => e.status);
    assert.ok(statuses.includes("complete"), `notes did not complete: ${statuses.join(",")}`);
    assert.ok(calls.length > 1, `expected several passes, got ${calls.length}`);

    // Nothing may be dropped: the last segment has to reach an extraction.
    const seen = calls.map((c) => c.text).join("\n");
    assert.ok(seen.includes("Segment 399"), "the tail of the transcript never reached the model");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a model family in the provider field still takes the local path", async () => {
  // Settings has been seen persisting "gemma" into the provider field. Sending
  // that down the cloud branch would put the whole transcript in one local call.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);
  let resolvedContext = false;

  process.env.NOTE_FORMATTING_PROVIDER = "gemma";
  process.env.NOTE_FORMATTING_MODEL = "google_gemma-4-E4B-it-Q4_K_M.gguf";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => {
        resolvedContext = true;
        return { contextSize: 8192, isGpuBackend: true };
      },
    });

    await manager.runSingleStep(1, "notes");

    assert.ok(resolvedContext, "a family-labelled local model must resolve a context");
    assert.ok(calls.length > 1, `expected several passes, got ${calls.length}`);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a cloud model gets the whole transcript, not the first 8000 characters", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);
  let resolvedContext = false;

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => {
        resolvedContext = true;
        return { contextSize: 8192, isGpuBackend: true };
      },
    });

    await manager.runSingleStep(1, "notes");

    assert.equal(calls.length, 1, "a cloud model needs exactly one call");
    assert.ok(calls[0].text.includes("Segment 399"), "the transcript was truncated");
    assert.equal(resolvedContext, false, "resolveModelContext throws for cloud model ids");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("without a context resolver a local model falls back to a single call", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.runSingleStep(1, "notes");

    assert.equal(calls.length, 1);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// Retranscription replaces the whole transcript with timestamps measured from the chosen
// AUDIO TRACK's zero, which is a different anchor from whatever transcript_origin_ms
// recorded. Leaving the old origin in place would have the column confidently describe an
// anchor the transcript no longer uses.
test("retranscribing clears the transcript origin instead of leaving a stale anchor", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push({ id, updates });
    return { success: true };
  };
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([
      { text: "hello", speaker: "speaker_0", source: "system", timestamp: 0 },
    ]),
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
    audio_duration_seconds: 300,
    transcript_origin_ms: 1788877046345,
    transcript_origin_source: "audio:system",
  });

  const fs = require("fs");
  const origExists = fs.existsSync;
  const origReadFile = fs.readFileSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin") ? true : origExists(p);
  fs.readFileSync = (...args) =>
    typeof args[0] === "string" && args[0].includes("ow-retranscribe")
      ? Buffer.from("fake wav")
      : origReadFile(...args);
  fs.unlinkSync = (p) => { if (!String(p).includes("ow-retranscribe")) origUnlink(p); };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const transcriptWrite = writes.find((w) => w.updates?.transcript != null);
    assert.ok(transcriptWrite, "retranscribe must have written a transcript");
    assert.equal(transcriptWrite.updates.transcript_origin_ms, null);
    assert.equal(transcriptWrite.updates.transcript_origin_source, "unanchored");
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origReadFile;
    fs.unlinkSync = origUnlink;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// Speaker labels reaching the notes model. The bug these cover: run() snapshotted
// the transcript once, so speaker attribution landing mid-pipeline was invisible to
// the notes step, and the model spliced a heard name onto a raw id --
// "Speaker 2 (Jay Carenderia)".

function speakerLabelMocks({ transcripts, mappings = [] }) {
  const calls = [];
  let getNoteCount = 0;
  return {
    calls,
    databaseManager: {
      getNote: () => {
        const transcript = transcripts[Math.min(getNoteCount, transcripts.length - 1)];
        getNoteCount += 1;
        return {
          id: 70,
          transcript: JSON.stringify(transcript),
          meeting_type_id: null,
          audio_duration_seconds: 300,
        };
      },
      updateNote: () => ({ success: true }),
      getMeetingType: () => null,
      getMeetingTypes: () => [],
      getSpeakerMappings: () => mappings,
    },
    whisperManager: { getModelPath: () => null },
    diarizationManager: { isAvailable: () => false },
    inference: {
      processText: async (text, opts) => {
        calls.push({ text, systemPrompt: opts.systemPrompt });
        return "## Summary\nnotes";
      },
    },
    convertToWav: async () => {},
  };
}

async function runNotesStep(mocks) {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";
  try {
    const manager = new PostCallPipelineManager({ broadcast: () => {}, ...mocks });
    await manager.run(70, { fromStep: "notes" });
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
  return mocks.calls[mocks.calls.length - 1]?.text ?? "";
}

test("notes step sees a name written after run() took its transcript snapshot", async () => {
  const unnamed = [{ speaker: "speaker_2", text: "Morning all.", source: "system", timestamp: 1 }];
  const named = [
    {
      speaker: "speaker_2",
      speakerName: "Jay",
      speakerIsPlaceholder: false,
      text: "Morning all.",
      source: "system",
      timestamp: 1,
    },
  ];
  const mocks = speakerLabelMocks({ transcripts: [unnamed, named] });
  const text = await runNotesStep(mocks);
  assert.match(text, /^Jay: Morning all\./m);
  assert.doesNotMatch(text, /speaker_2/);
});

test("notes step does not trust a placeholder name over the stored mapping", async () => {
  const segments = [
    {
      speaker: "speaker_2",
      speakerName: "Speaker 3",
      speakerIsPlaceholder: true,
      text: "Morning all.",
      source: "system",
      timestamp: 1,
    },
  ];
  const mocks = speakerLabelMocks({
    transcripts: [segments],
    mappings: [{ speaker_id: "speaker_2", display_name: "Jay" }],
  });
  const text = await runNotesStep(mocks);
  assert.match(text, /^Jay: Morning all\./m);
});

test("an unnamed speaker reaches the model one-indexed, never as a raw id", async () => {
  const segments = [{ speaker: "speaker_2", text: "Morning all.", source: "system", timestamp: 1 }];
  const mocks = speakerLabelMocks({ transcripts: [segments] });
  const text = await runNotesStep(mocks);
  assert.match(text, /^Speaker 3: Morning all\./m);
  assert.doesNotMatch(text, /speaker_2/);
});

test("mic turns reach the model as You", async () => {
  const segments = [{ speaker: "you", text: "Thanks everybody.", source: "mic", timestamp: 1 }];
  const mocks = speakerLabelMocks({ transcripts: [segments] });
  const text = await runNotesStep(mocks);
  assert.match(text, /^You: Thanks everybody\./m);
});

test("an unattributed system turn is labelled rather than left bare", async () => {
  const segments = [{ text: "Somewhere in Berlin.", source: "system", timestamp: 1 }];
  const mocks = speakerLabelMocks({ transcripts: [segments] });
  const text = await runNotesStep(mocks);
  const othersLabel = require("../../src/helpers/i18nMain.js").i18nMain.t(
    "transcript.speaker.others"
  );
  assert.equal(text, `${othersLabel}: Somewhere in Berlin.`);
});

test("notes are still generated when the database has no getSpeakerMappings", async () => {
  const segments = [{ speaker: "speaker_2", text: "Morning all.", source: "system", timestamp: 1 }];
  const mocks = speakerLabelMocks({ transcripts: [segments] });
  delete mocks.databaseManager.getSpeakerMappings;
  const text = await runNotesStep(mocks);
  assert.match(text, /^Speaker 3: Morning all\./m);
});

test("the notes prompt forbids gluing a heard name onto a speaker label", async () => {
  const segments = [{ speaker: "speaker_2", text: "Morning all.", source: "system", timestamp: 1 }];
  const mocks = speakerLabelMocks({ transcripts: [segments] });
  await runNotesStep(mocks);
  const { systemPrompt } = mocks.calls[mocks.calls.length - 1];
  assert.match(systemPrompt, /introduced themselves as/);
});

test("the chunked path resolves labels the same way as the single-call path", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const manager = new PostCallPipelineManager({
    broadcast: () => {},
    ...speakerLabelMocks({
      transcripts: [[]],
      mappings: [{ speaker_id: "speaker_2", display_name: "Jay" }],
    }),
  });
  const transcript = JSON.stringify([
    { speaker: "speaker_2", text: "Morning all.", source: "system", timestamp: 1 },
    { speaker: "speaker_5", text: "Hello.", source: "system", timestamp: 2 },
  ]);
  const segments = manager._transcriptSegments(70, transcript);
  assert.deepEqual(
    segments.map((s) => s.label),
    ["Jay", "Speaker 6"]
  );
});

// ── Title context (1.24.0) ──────────────────────────────────────────────────
//
// Titles were generated from `text.slice(0, 2000)` of the flattened transcript,
// before classification, with no participant names in the prompt. A 2h19m call
// with 11 speakers came out as "Meeting Logistics and Introductions Discussed":
// the model only ever saw the opening small talk.
//
// The fix is a bounded digest (roster + beginning/middle/end), classify moved
// ahead of title so the type is known, and both threaded into the prompt. The
// budget is derived from the model's context on a local provider, because the
// title step is FATAL to the run (`if (titleResult.error) return;`) and a prompt
// over the 2048-context floor would cost the user the notes as well.

const TITLE_SEGMENTS = Array.from({ length: 400 }, (_, i) => ({
  text: `Segment ${i}: we discussed the quarterly rollout and agreed on the staffing plan.`,
  speaker: i === 0 ? "speaker_0" : `speaker_${i % 3}`,
  source: "system",
  timestamp: i,
}));

function titleMocks(createMocks, overrides = {}) {
  const mocks = createMocks();
  const transcript = overrides.transcript ?? JSON.stringify(TITLE_SEGMENTS);
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript,
    title: "New note",
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: overrides.meetingTypeId ?? null,
    audio_duration_seconds: 8361,
  });
  return mocks;
}

// Records every inference call, keyed by which step made it. The shared mock
// routes on `systemPrompt.includes("title")`, so the title prompt must keep
// that word — if it stops doing so these tests capture the notes call instead.
const isTitlePrompt = (systemPrompt) => systemPrompt.includes("Generate a concise");
const isClassifyPrompt = (systemPrompt) => systemPrompt.includes("meeting classifier");

function captureCalls(mocks) {
  const calls = [];
  mocks.inference.processText = async (text, opts) => {
    calls.push({ text, opts });
    if (isTitlePrompt(opts.systemPrompt)) return "1:1 with Mike";
    if (isClassifyPrompt(opts.systemPrompt)) return "none";
    return "## Summary\nTest notes";
  };
  const titleCall = () => calls.find((c) => isTitlePrompt(c.opts.systemPrompt));
  const classifyCall = () => calls.find((c) => isClassifyPrompt(c.opts.systemPrompt));
  return { calls, titleCall, classifyCall };
}

function buildManager(PostCallPipelineManager, mocks, extra = {}) {
  return new PostCallPipelineManager({
    broadcast: mocks.broadcast,
    databaseManager: mocks.databaseManager,
    whisperManager: mocks.whisperManager,
    diarizationManager: mocks.diarizationManager,
    inference: mocks.inference,
    convertToWav: mocks.convertToWav,
    ...extra,
  });
}

test("the title sees the end of a long meeting, not just its opening", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = titleMocks(createMocks);
  const { titleCall } = captureCalls(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    await buildManager(PostCallPipelineManager, mocks).run(1);

    const call = titleCall();
    assert.ok(call, "the title step never called the model");
    assert.ok(call.text.includes("Segment 0"), "the opening never reached the title model");
    assert.ok(
      call.text.includes("Segment 399"),
      "the END of the meeting never reached the title model — this is the whole defect"
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("the title prompt is told who was in the room", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = titleMocks(createMocks);
  mocks.databaseManager.getSpeakerMappings = () => [
    { speaker_id: "speaker_0", display_name: "Mike" },
  ];
  const { titleCall } = captureCalls(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    await buildManager(PostCallPipelineManager, mocks).run(1);

    const call = titleCall();
    assert.ok(call, "the title step never called the model");
    assert.match(
      call.text,
      /Participants:/,
      "the digest carries no participant roster, so the model cannot write \"1:1 with Mike\""
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify runs before title, so the title knows the meeting type", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = titleMocks(createMocks);
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 7, name: "1:1", keyword_rules: JSON.stringify(["one on one"]) },
  ];
  mocks.databaseManager.getMeetingType = (id) => (id === 7 ? { id: 7, name: "1:1" } : null);

  // The write has to be visible to the next getNote, or _buildTitlePrompt reads
  // a null type and the "did the type reach the prompt" assertion below is
  // testing nothing.
  const note = {
    id: 1,
    transcript: JSON.stringify(TITLE_SEGMENTS),
    title: "New note",
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
    audio_duration_seconds: 8361,
  };
  mocks.databaseManager.getNote = () => ({ ...note });
  let classified = false;
  mocks.databaseManager.updateNote = (id, updates) => {
    Object.assign(note, updates);
    if (updates.meeting_type_id) classified = true;
    return { success: true };
  };

  const calls = [];
  mocks.inference.processText = async (text, opts) => {
    calls.push({ text, opts, classifiedByNow: classified });
    if (isTitlePrompt(opts.systemPrompt)) return "1:1 with Mike";
    if (isClassifyPrompt(opts.systemPrompt)) return "7";
    return "## Summary\nTest notes";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    await buildManager(PostCallPipelineManager, mocks).run(1);

    const title = calls.find((c) => isTitlePrompt(c.opts.systemPrompt));
    assert.ok(title, "the title step never called the model");
    assert.ok(
      title.classifiedByNow,
      "the title ran before the meeting type was written — it cannot know this is a 1:1"
    );
    assert.match(
      title.opts.systemPrompt,
      /classified as "1:1"/,
      "the classified meeting type never reached the title prompt"
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a 2048-context local model gets a title prompt that fits its budget", async () => {
  // The title step is fatal: `if (titleResult.error) return;`. At the MIN_CONTEXT
  // floor the budget is floor(2048 * 0.6) = 1228 tokens over systemPrompt+prompt
  // at 3.6 chars/token. A flat 6k digest overruns it, throws
  // LOCAL_CONTEXT_EXCEEDED, and takes the notes down with it.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const { estimatePromptTokens } = require("../../src/helpers/llamaContext.js");
  const mocks = titleMocks(createMocks);
  const { titleCall } = captureCalls(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    const manager = buildManager(PostCallPipelineManager, mocks, {
      resolveModelContext: async () => ({ contextSize: 2048, isGpuBackend: false }),
    });

    await manager.run(1);

    const call = titleCall();
    assert.ok(call, "the title step never called the model");

    const estimated = estimatePromptTokens(`${call.opts.systemPrompt}${call.text}`);
    assert.ok(
      estimated <= 1228,
      `title prompt is ${estimated} tokens against a budget of 1228 — this throws ` +
        `LOCAL_CONTEXT_EXCEEDED and costs the user the notes as well`
    );
    assert.ok(
      call.text.length > 2000,
      "the digest shrank below the old 2000-char slice, so the fix bought nothing here"
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a plain-text transcript still reaches the title model", async () => {
  // _transcriptSegments returns [] for anything not starting with "[", and the
  // codebase treats plain text as a real input. A segment-only digest would send
  // an empty string.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const longPlainText = Array.from(
    { length: 400 },
    (_, i) => `Line ${i}: we discussed the quarterly rollout and agreed on the staffing plan.`
  ).join("\n");
  const mocks = titleMocks(createMocks, { transcript: longPlainText });
  const { titleCall } = captureCalls(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    await buildManager(PostCallPipelineManager, mocks).run(1);

    const call = titleCall();
    assert.ok(call, "the title step never called the model");
    assert.ok(call.text.trim().length > 0, "the digest sent an EMPTY prompt for plain text");
    assert.ok(call.text.includes("Line 0"), "the opening never reached the title model");
    assert.ok(call.text.includes("Line 399"), "the end never reached the title model");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("the classify keyword fallback still matches a keyword spoken late in the meeting", async () => {
  // The .slice(0, 2000) at the classify LLM call is NOT what the keyword
  // fallback reads -- it reads the whole flattened transcript. Replacing that
  // shared variable with the digest would lose a "one on one" said at minute 50.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const segments = TITLE_SEGMENTS.map((s) => ({ ...s }));
  segments[250] = { ...segments[250], text: "Segment 250: this is really a one on one." };
  const mocks = titleMocks(createMocks, { transcript: JSON.stringify(segments) });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 7, name: "1:1", keyword_rules: JSON.stringify(["one on one"]) },
  ];
  mocks.databaseManager.getMeetingType = (id) => (id === 7 ? { id: 7, name: "1:1" } : null);

  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push(updates);
    return { success: true };
  };

  mocks.inference.processText = async (text, opts) => {
    // The LLM classifier declines, so the keyword fallback decides.
    if (isClassifyPrompt(opts.systemPrompt)) return "none";
    if (isTitlePrompt(opts.systemPrompt)) return "1:1 with Mike";
    return "## Summary\nTest notes";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    await buildManager(PostCallPipelineManager, mocks).run(1);

    assert.ok(
      writes.some((w) => w.meeting_type_id === 7),
      "a keyword at minute 50 stopped matching — the fallback no longer reads the full transcript"
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("the digest never exceeds the budget it was given", async () => {
  // The budget is not a preference, it is the promise the local context guard
  // relies on: `checkPromptFitsContext` throws above `contextSize * PROMPT_SHARE`,
  // a throwing title step aborts run(), and the user loses their notes too.
  //
  // The first draft let the first line of each window through unconditionally,
  // so a plain-text transcript -- which flattens to ONE line -- came back at
  // 150,089 characters against a 6,000 budget, the same line repeated in all
  // three windows.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");

  const shapes = {
    "many short lines": Array.from({ length: 400 }, (_, i) => ({
      text: `Segment ${i}: ${"x".repeat(60)}`,
      speaker: `speaker_${i % 3}`,
    })),
    "one enormous line": [{ text: "y".repeat(50000), speaker: "speaker_0" }],
    "two long lines": [
      { text: "a".repeat(4000), speaker: "speaker_0" },
      { text: "b".repeat(4000), speaker: "speaker_1" },
    ],
    "no segments at all": [],
  };

  for (const [shape, segments] of Object.entries(shapes)) {
    const transcript = JSON.stringify(segments);
    const manager = new PostCallPipelineManager({
      broadcast: () => {},
      databaseManager: {
        getNote: () => ({ transcript }),
        getSpeakerMappings: () => [],
      },
      whisperManager: {},
      diarizationManager: {},
      inference: {},
      convertToWav: async () => {},
    });

    for (const budget of [6000, 3278, 100, 0]) {
      const digest = manager._transcriptDigest(1, transcript, budget);
      assert.ok(
        digest.length <= budget,
        `${shape} at budget ${budget} produced ${digest.length} chars`
      );
    }
  }
});

test("a single-line plain-text transcript is not sent three times over", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const transcript = "z".repeat(50000);
  const manager = new PostCallPipelineManager({
    broadcast: () => {},
    databaseManager: { getNote: () => ({ transcript }), getSpeakerMappings: () => [] },
    whisperManager: {},
    diarizationManager: {},
    inference: {},
    convertToWav: async () => {},
  });

  const digest = manager._transcriptDigest(1, transcript, 6000);
  assert.ok(digest.length <= 6000, `plain text digest was ${digest.length} chars`);
  assert.ok(digest.includes("z"), "the transcript never reached the digest at all");
});

test("a title that overruns the local context retries instead of killing the notes", async () => {
  // `_resolveModelContext` and the llama server's own contextSize are read from
  // different places and can disagree. When they do, modelManagerBridge throws
  // ModelError(code: "LOCAL_CONTEXT_EXCEEDED") -- which reaches here intact,
  // because localReasoningBridge rethrows the original and processText returns
  // the handler's promise unwrapped. Without the retry, `if (titleResult.error)
  // return;` costs the user the notes as well as the title.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = titleMocks(createMocks);

  const calls = [];
  mocks.inference.processText = async (text, opts) => {
    calls.push({ text, opts });
    if (isTitlePrompt(opts.systemPrompt)) {
      const titleAttempts = calls.filter((c) => isTitlePrompt(c.opts.systemPrompt)).length;
      if (titleAttempts === 1) {
        const err = new Error("Prompt is too long for this model");
        err.code = "LOCAL_CONTEXT_EXCEEDED";
        throw err;
      }
      return "1:1 with Mike";
    }
    if (isClassifyPrompt(opts.systemPrompt)) return "none";
    return "## Summary\nTest notes";
  };

  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push(updates);
    return { success: true };
  };

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    await buildManager(PostCallPipelineManager, mocks, {
      resolveModelContext: async () => ({ contextSize: 2048, isGpuBackend: false }),
    }).run(1);

    const titleAttempts = calls.filter((c) => isTitlePrompt(c.opts.systemPrompt));
    assert.equal(titleAttempts.length, 2, "the title step did not retry after the context refusal");
    assert.ok(
      titleAttempts[1].text.length < titleAttempts[0].text.length,
      "the retry resent a prompt no smaller than the one that was just refused"
    );
    assert.equal(writes.find((w) => w.title !== undefined)?.title, "1:1 with Mike");
    // Whether the notes then SUCCEED is the notes path's own business -- at a
    // 2048 context it refuses a transcript this long, and did so before this
    // change. What matters here is that run() reached the step at all rather
    // than returning at `if (titleResult.error) return;`.
    assert.ok(
      mocks.events.some((e) => e.step === "notes" && e.status === "running"),
      "run() aborted before the notes step — this is the failure the retry exists to prevent"
    );
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// BLAST-RADIUS: the reorder changes what each `fromStep` re-runs, and the retry
// menu (PersonalNotesView -> retry-pipeline-step) feeds it whatever
// resolveRetryStep decided. Walk every value that function can actually emit.
test("every step the retry menu can ask for re-runs the right set", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const { resolveRetryStep } = require("../../src/helpers/noteRetryStep.js");

  const emitted = new Set(
    [
      { transcript: null, system_audio_path: "/tmp/a.opus" },
      { transcript: "words", enhanced_content: null },
      { transcript: "words", enhanced_content: "## Notes", title: "New note" },
      { transcript: "words", enhanced_content: "## Notes", title: "Real Title" },
    ]
      .map((note) => resolveRetryStep(note).step)
      .filter(Boolean)
  );
  assert.deepEqual(
    [...emitted].sort(),
    ["notes", "retranscribe", "title"],
    "resolveRetryStep emits a step this test does not cover"
  );

  const expected = {
    retranscribe: ["retranscribe", "classify", "title", "notes"],
    // Classification is settled before the title now, so a title retry can no
    // longer rewrite the meeting type the user chose.
    title: ["title", "notes"],
    notes: ["notes"],
  };

  for (const [fromStep, wanted] of Object.entries(expected)) {
    const mocks = titleMocks(createMocks);
    captureCalls(mocks);
    mocks.databaseManager.getMeetingTypes = () => [];

    process.env.NOTE_FORMATTING_PROVIDER = "openai";
    process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";
    try {
      await buildManager(PostCallPipelineManager, mocks).run(1, { fromStep });
      const ran = [
        ...new Set(
          mocks.events
            .filter((e) => e.channel === "post-call-pipeline-status" && e.step !== "pipeline")
            .map((e) => e.step)
        ),
      ];
      assert.deepEqual(ran, wanted, `fromStep "${fromStep}" ran ${ran.join(",")}`);
    } finally {
      delete process.env.NOTE_FORMATTING_PROVIDER;
      delete process.env.NOTE_FORMATTING_MODEL;
    }
  }
});
