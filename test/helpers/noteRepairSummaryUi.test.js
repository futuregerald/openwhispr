const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LOCALES = ["en", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];
const REQUIRED_KEYS = ["title", "description", "action"];

const repoFile = (relative) =>
  fs.readFileSync(path.join(__dirname, "../..", relative), "utf8");

test("every locale carries the repair summary strings", () => {
  for (const locale of LOCALES) {
    const translation = JSON.parse(repoFile(`src/locales/${locale}/translation.json`));
    const section = translation.noteAttributionRepair;
    assert.ok(section, `${locale} is missing noteAttributionRepair`);
    for (const key of REQUIRED_KEYS) {
      assert.equal(
        typeof section[key],
        "string",
        `${locale} is missing noteAttributionRepair.${key}`
      );
      assert.ok(section[key].trim().length > 0, `${locale} noteAttributionRepair.${key} is empty`);
    }
  }
});

test("every translated description keeps both interpolations", () => {
  for (const locale of LOCALES) {
    const translation = JSON.parse(repoFile(`src/locales/${locale}/translation.json`));
    const { description } = translation.noteAttributionRepair;
    assert.match(description, /\{\{count\}\}/, `${locale} dropped {{count}}`);
    assert.match(description, /\{\{notes\}\}/, `${locale} dropped {{notes}}`);
  }
});

test("the summary is reachable from the renderer", () => {
  const preload = repoFile("preload.js");
  assert.match(preload, /getNoteRepairSummary:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(/);
  assert.match(preload, /acknowledgeNoteRepairSummary:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(/);
  assert.match(preload, /"get-note-repair-summary"/);
  assert.match(preload, /"acknowledge-note-repair-summary"/);

  const handlers = repoFile("src/helpers/ipcHandlers.js");
  assert.match(handlers, /ipcMain\.handle\("get-note-repair-summary"/);
  assert.match(handlers, /ipcMain\.handle\("acknowledge-note-repair-summary"/);

  const types = repoFile("src/types/electron.ts");
  assert.match(types, /getNoteRepairSummary\??:/);
  assert.match(types, /acknowledgeNoteRepairSummary\??:/);
});

test("the control panel shows the summary once and then clears it", () => {
  const controlPanel = repoFile("src/components/ControlPanel.tsx");
  assert.match(controlPanel, /getNoteRepairSummary/);
  assert.match(controlPanel, /acknowledgeNoteRepairSummary/);
  assert.match(controlPanel, /noteAttributionRepair\.title/);
  assert.match(controlPanel, /noteAttributionRepair\.description/);
});

test("repair never reaches the machinery that rewrites other notes", () => {
  const source = repoFile("src/helpers/noteAttributionRepair.js");
  assert.doesNotMatch(source, /_persistDiarizedTranscript/);
  assert.doesNotMatch(source, /_asyncVectorUpsert/);
  assert.doesNotMatch(source, /vectorIndex/);
  assert.doesNotMatch(
    source,
    /\.updateNote\(/,
    "updateNote restamps updated_at, which reorders the user's note list"
  );
});

test("the repair IPC method writes through the timestamp-preserving path only", () => {
  const handlers = repoFile("src/helpers/ipcHandlers.js");
  const start = handlers.indexOf("  repairNoteAttribution(noteId) {");
  const end = handlers.indexOf("  _enqueueNoteAttributionRepairs() {");
  assert.ok(start > -1 && end > start, "could not locate the repair method");

  const method = handlers.slice(start, end);
  assert.doesNotMatch(method, /_updateNoteAndNotify/);
  assert.doesNotMatch(method, /_persistDiarizedTranscript/);
  assert.match(method, /repairStoredNoteAttribution\(/);
});
