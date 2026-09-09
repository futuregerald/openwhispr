const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const ffmpegUtils = require("../../src/helpers/ffmpegUtils");
const debugLogger = require("../../src/helpers/debugLogger");
const { parseMeetingNoteId } = require("../../src/helpers/audioRetention");

const NOTE_ID = 4242;
const PCM_BYTES = Buffer.from("raw-pcm-that-must-survive-a-failed-encode");

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-encode-failure-"));
  const audioDir = path.join(root, "userData", "audio");
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, audioDir, tmpDir };
}

function writePcm(dir, name) {
  const pcmPath = path.join(dir, name);
  fs.writeFileSync(pcmPath, PCM_BYTES);
  return pcmPath;
}

function createHandlers(audioDir) {
  const noteWrites = [];
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    audioStorageManager: { audioDir },
    databaseManager: {
      updateNote: (id, updates) => {
        noteWrites.push({ id, updates });
        return { success: true };
      },
    },
  });
  return { handlers, noteWrites };
}

function captureLogs(t) {
  const entries = [];
  for (const level of ["error", "warn", "notice", "info"]) {
    const original = debugLogger[level];
    debugLogger[level] = (message, meta, scope) => {
      entries.push({ level, message, meta, scope });
    };
    t.after(() => {
      debugLogger[level] = original;
    });
  }
  return entries;
}

function stubEncode(t, impl) {
  const original = ffmpegUtils.encodePcmToOpus;
  ffmpegUtils.encodePcmToOpus = impl;
  t.after(() => {
    ffmpegUtils.encodePcmToOpus = original;
  });
}

test("a failed opus encode moves the raw PCM into the retention directory", async (t) => {
  const { audioDir, tmpDir } = createWorkspace(t);
  const micPcm = writePcm(tmpDir, "ow-diarize-raw-1.pcm");
  const systemPcm = writePcm(tmpDir, "ow-diarize-raw-2.pcm.save-1.pcm");

  stubEncode(t, async () => {
    throw new Error("ffmpeg not found");
  });
  const logs = captureLogs(t);
  const { handlers, noteWrites } = createHandlers(audioDir);

  const saved = await handlers._saveMeetingAudio(NOTE_ID, micPcm, systemPcm);

  assert.deepEqual(saved, { micPath: null, systemPath: null });
  assert.deepEqual(noteWrites, []);

  assert.equal(fs.existsSync(micPcm), false, "the temp-dir PCM must not be left behind");
  assert.equal(fs.existsSync(systemPcm), false, "the temp-dir PCM must not be left behind");

  const rescued = fs.readdirSync(audioDir).filter((name) => name.endsWith(".pcm")).sort();
  assert.deepEqual(rescued.map((name) => name.replace(/-\d{4}-\d{2}-\d{2}-\d{4}-/, "-STAMP-")), [
    `OpenWhispr-meeting-${NOTE_ID}-STAMP-mic.pcm`,
    `OpenWhispr-meeting-${NOTE_ID}-STAMP-system.pcm`,
  ]);
  for (const name of rescued) {
    assert.equal(parseMeetingNoteId(name), NOTE_ID, "the retention sweep must recognise the file");
    assert.deepEqual(fs.readFileSync(path.join(audioDir, name)), PCM_BYTES);
  }

  const failureLogs = logs.filter((entry) => /encode failed/i.test(String(entry.message)));
  assert.equal(failureLogs.length, 2);
  for (const entry of failureLogs) {
    assert.equal(entry.level, "error", "losing a meeting's audio is not a debug-level event");
    assert.ok(entry.meta?.retainedPcmPath, "the log must say where the PCM went");
    assert.equal(fs.existsSync(entry.meta.retainedPcmPath), true);
  }
});

test("the temp-dir PCM is kept when it cannot be moved into the retention directory", async (t) => {
  const { audioDir, tmpDir } = createWorkspace(t);
  const micPcm = writePcm(tmpDir, "ow-diarize-raw-3.pcm");
  fs.rmSync(audioDir, { recursive: true, force: true });
  fs.writeFileSync(audioDir, "not a directory");

  stubEncode(t, async () => {
    throw new Error("ffmpeg not found");
  });
  const logs = captureLogs(t);
  const { handlers } = createHandlers(audioDir);

  const saved = await handlers._saveMeetingAudio(NOTE_ID, micPcm, null);

  assert.equal(saved.micPath, null);
  assert.equal(fs.existsSync(micPcm), true, "an unmovable PCM must never be deleted");
  const failureLogs = logs.filter((entry) => /encode failed/i.test(String(entry.message)));
  assert.equal(failureLogs.length, 1);
  assert.equal(failureLogs[0].level, "error");
});

test("a successful encode still deletes the raw PCM and records the opus path", async (t) => {
  const { audioDir, tmpDir } = createWorkspace(t);
  const micPcm = writePcm(tmpDir, "ow-diarize-raw-4.pcm");
  const systemPcm = writePcm(tmpDir, "ow-diarize-raw-5.pcm.save-1.pcm");

  stubEncode(t, async (_pcmPath, outFile) => {
    fs.writeFileSync(outFile, "opus");
  });
  captureLogs(t);
  const { handlers, noteWrites } = createHandlers(audioDir);

  const saved = await handlers._saveMeetingAudio(NOTE_ID, micPcm, systemPcm);

  assert.equal(fs.existsSync(micPcm), false);
  assert.equal(fs.existsSync(systemPcm), false);
  assert.deepEqual(
    fs.readdirSync(audioDir).filter((name) => name.endsWith(".pcm")),
    []
  );
  assert.ok(saved.micPath?.endsWith("-mic.opus"));
  assert.ok(saved.systemPath?.endsWith("-system.opus"));
  assert.deepEqual(noteWrites, [
    { id: NOTE_ID, updates: { mic_audio_path: saved.micPath, system_audio_path: saved.systemPath } },
  ]);
});
