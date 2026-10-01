const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

// A broadcast reaches the renderer only if every layer is present. An ipcMain
// handler with no preload entry is unreachable -- the #90 repair-qdrant lesson
// -- and preload.js has no runtime harness here, so this is static.
//
// The raw channel string belongs to the two ends of the IPC only; consumers go
// through the preload accessor, exactly as the dictionary broadcast does.
const WIRING = {
  "user-context-updated": {
    channel: ["src/helpers/cliBridge.js", "preload.js"],
    accessor: "onUserContextUpdated",
    consumers: ["src/hooks/useSettings.ts"],
  },
  "speaker-mappings-updated": {
    channel: ["src/helpers/cliBridge.js", "preload.js"],
    accessor: "onSpeakerMappingsUpdated",
    consumers: ["src/components/notes/NoteEditor.tsx"],
  },
};

for (const [channel, wiring] of Object.entries(WIRING)) {
  test(`the ${channel} channel is wired end to end`, () => {
    for (const file of wiring.channel) {
      assert.ok(
        read(file).includes(`"${channel}"`),
        `${file} never names ${channel}, so the two ends of the IPC disagree`
      );
    }
    assert.match(
      read("preload.js"),
      new RegExp(`${wiring.accessor}: \\(callback\\)`),
      `${wiring.accessor} is missing from preload.js, so the channel is unreachable`
    );
    assert.ok(
      read("src/types/electron.ts").includes(`${wiring.accessor}?:`),
      `${wiring.accessor} is missing from the ElectronAPI type, so typecheck cannot catch misuse`
    );
    for (const file of wiring.consumers) {
      assert.ok(
        read(file).includes(wiring.accessor),
        `${file} never subscribes to ${wiring.accessor}, so the broadcast changes nothing on screen`
      );
    }
  });
}

test("every new preload listener returns a disposer", () => {
  const preload = read("preload.js");
  for (const accessor of ["onUserContextUpdated", "onSpeakerMappingsUpdated"]) {
    const start = preload.indexOf(`${accessor}: (callback)`);
    assert.ok(start > 0, `${accessor} missing`);
    const body = preload.slice(start, preload.indexOf("\n  },", start));
    assert.ok(
      body.includes("ipcRenderer.removeListener"),
      `${accessor} never removes its listener, so it leaks on every remount`
    );
  }
});

// --- the noteId guard, driven rather than text-matched ---------------------
// A text assertion that the guard EXISTS survived deleting it, because the
// assertion matched the wiring and not the behaviour. This drives it.
const { speakerMappingsForBroadcast } = require("../../src/helpers/speakerMappingBroadcast.js");

test("a mapping broadcast for a different note is ignored", () => {
  const payload = { noteId: 7, mappings: [{ speaker_id: "speaker_0", display_name: "Priya" }] };
  assert.equal(
    speakerMappingsForBroadcast(payload, 3),
    null,
    "a rename in another note relabelled the open one"
  );
  assert.equal(speakerMappingsForBroadcast(payload, undefined), null);
  assert.equal(speakerMappingsForBroadcast(null, 7), null);
});

test("a mapping broadcast for this note replaces the whole map", () => {
  const map = speakerMappingsForBroadcast(
    {
      noteId: 3,
      mappings: [
        { speaker_id: "speaker_0", display_name: "Priya" },
        { speaker_id: "speaker_1", display_name: "Dana" },
      ],
    },
    3
  );
  assert.deepEqual(map, { speaker_0: "Priya", speaker_1: "Dana" });
});

// A removed mapping must disappear from the map, not linger. Returning the
// previous map on an empty list would leave a deleted name on screen.
test("an empty mapping list clears the map rather than leaving it stale", () => {
  assert.deepEqual(speakerMappingsForBroadcast({ noteId: 3, mappings: [] }, 3), {});
  assert.deepEqual(speakerMappingsForBroadcast({ noteId: 3 }, 3), {});
});

test("a malformed mapping row is skipped rather than writing undefined on screen", () => {
  const map = speakerMappingsForBroadcast(
    {
      noteId: 3,
      mappings: [
        null,
        { speaker_id: "speaker_0" },
        { display_name: "Orphan" },
        { speaker_id: "speaker_1", display_name: "" },
        { speaker_id: 7, display_name: "Numeric" },
        { speaker_id: "speaker_2", display_name: "Priya" },
      ],
    },
    3
  );
  assert.deepEqual(map, { speaker_2: "Priya" });
});

test("the NoteEditor mapping subscription is disposed", () => {
  const editor = read("src/components/notes/NoteEditor.tsx");
  const start = editor.indexOf("onSpeakerMappingsUpdated");
  assert.ok(start > 0);
  const effect = editor.slice(start, editor.indexOf("}, [", start) + 40);
  assert.ok(
    effect.includes("return unsubscribe"),
    "the listener leaks on every note switch, and stale listeners relabel the wrong note"
  );
});

// Anchors on the implementation, not the `=> void;` interface declaration -- the
// bare name matched that first and silently asserted against the wrong text.
function storeFunctionBody(name) {
  const store = read("src/stores/settingsStore.ts");
  const marker = `${name}: (patch: { general?: string; dictation?: string }) => {`;
  const start = store.indexOf(marker);
  assert.ok(start > 0, `${name} implementation not found`);
  return store.slice(start, store.indexOf("\n  },", start));
}

// --- the context patch, driven -------------------------------------------
// Review proved the previous versions of these could not fail: `set(next)` ->
// `set({})`, writing the dictation value into the generalContext mirror, and a
// hook that subscribed but applied nothing all passed 13/13. They were
// body-wide substring matches on source text. The logic now lives in a pure
// function and is driven.
const {
  userContextPatchToState,
  USER_CONTEXT_STATE_KEYS,
  GENERAL_CONTEXT_MAX_CHARS: GEN_CAP,
  DICTATION_CONTEXT_MAX_CHARS: DICT_CAP,
} = require("../../src/helpers/userContextBlock.js");

test("each context field maps to its own state key", () => {
  assert.deepEqual(userContextPatchToState({ general: "a", dictation: "b" }), {
    generalContext: "a",
    dictationContext: "b",
  });
});

test("a partial patch yields only that field, so the other cannot be blanked", () => {
  assert.deepEqual(userContextPatchToState({ general: "a" }), { generalContext: "a" });
  assert.deepEqual(userContextPatchToState({ dictation: "b" }), { dictationContext: "b" });
});

test("an empty or nullish patch yields nothing to apply", () => {
  for (const patch of [{}, null, undefined, { sneaky: "x" }]) {
    assert.deepEqual(userContextPatchToState(patch), {}, `patch ${JSON.stringify(patch)}`);
  }
});

// An external writer is not necessarily the user, and the bridge caps on the way
// in -- but the renderer must not depend on that.
test("each field is capped at its own limit, not the other's", () => {
  const long = "x".repeat(9000);
  const next = userContextPatchToState({ general: long, dictation: long });
  assert.equal(next.generalContext.length, GEN_CAP);
  assert.equal(next.dictationContext.length, DICT_CAP);
  assert.notEqual(GEN_CAP, DICT_CAP);
});

test("an explicitly empty value clears the field rather than being ignored", () => {
  assert.deepEqual(userContextPatchToState({ general: "" }), { generalContext: "" });
});

test("the state keys are also the localStorage keys the store mirrors", () => {
  assert.deepEqual(USER_CONTEXT_STATE_KEYS, {
    general: "generalContext",
    dictation: "dictationContext",
  });
});

// --- the rename refresh, driven -------------------------------------------
const { externalRenameUpdate } = require("../../src/helpers/speakerMappingBroadcast.js");

// The CRITICAL from review: displaySegments prefers the local diarizedSegments
// array over note.transcript, and any in-editor speaker edit populates it for
// the rest of the session. An external rename rewrote the transcript, so the
// local array is stale -- and the next in-editor edit writes it back over the
// rename, reverting exports and the search index while the label still reads
// the new name.
test("an external rename for this note drops the stale local segment array", () => {
  const update = externalRenameUpdate(
    { noteId: 3, mappings: [{ speaker_id: "speaker_0", display_name: "Priya" }] },
    3
  );
  assert.deepEqual(update.mappings, { speaker_0: "Priya" });
  assert.equal(
    update.clearLocalSegments,
    true,
    "without this the next in-editor edit writes the pre-rename transcript back"
  );
});

test("an external rename for another note changes nothing at all", () => {
  assert.equal(externalRenameUpdate({ noteId: 7, mappings: [] }, 3), null);
  assert.equal(externalRenameUpdate(null, 3), null);
});

// --- the irreducible glue -------------------------------------------------
// There is no renderer test harness in this repo, so these call sites can only
// be pinned by their exact form. Each assertion below was checked against the
// mutation it is meant to catch.
test("the store applies the pure result to both the mirror and the state", () => {
  const body = storeFunctionBody("applyUserContextFromExternal");
  assert.match(body, /const next = userContextPatchToState\(patch\)/);
  assert.match(body, /localStorage\.setItem\(key, value\)/, "the mirror is not derived from next");
  assert.match(body, /\bset\(next\)/, "set({}) would leave the store state untouched");
  assert.ok(!body.includes("setUserContext"), "writing back to SQLite would loop");
});

test("NoteEditor passes its own note id, not the payload's", () => {
  const editor = read("src/components/notes/NoteEditor.tsx");
  assert.match(
    editor,
    /externalRenameUpdate\(payload, note\.id, autoMappingsRef\.current\)/,
    "passing payload.noteId makes every rename anywhere relabel the open note"
  );
  assert.match(
    editor,
    /if \(update\.clearLocalSegments\) setDiarizedSegments\(null\)/,
    "the stale local segment array is never cleared"
  );
});

test("the useSettings effect applies the patch rather than only subscribing", () => {
  const hook = read("src/hooks/useSettings.ts");
  assert.match(
    hook,
    /applyUserContextFromExternal\(context\)/,
    "the dependency array alone satisfied the previous assertion"
  );
});

// The route calls ipc.mapLiveSpeaker?.(...) with optional chaining, so a missing
// method is a silent no-op forever -- the repair-qdrant lesson, where a handler
// with no counterpart was unreachable and nothing failed.
test("the methods the bridge calls on IPCHandlers actually exist on it", () => {
  const handlers = read("src/helpers/ipcHandlers.js");
  for (const method of ["mapLiveSpeaker", "_asyncVectorUpsert", "_asyncMirrorWrite"]) {
    assert.match(
      handlers,
      new RegExp(`^  ${method}\\(`, "m"),
      `cliBridge calls ipc.${method}, but IPCHandlers does not define it`
    );
  }
});

// M13: diarization-derived names are never persisted, so a broadcast carrying
// only stored rows must not discard them.
test("an external rename keeps diarization-derived names for other speakers", () => {
  const update = externalRenameUpdate(
    { noteId: 3, mappings: [{ speaker_id: "speaker_0", display_name: "Priya" }] },
    3,
    { speaker_0: "Priyanka", speaker_1: "Dana" }
  );
  assert.deepEqual(
    update.mappings,
    { speaker_0: "Priya", speaker_1: "Dana" },
    "the stored row must win, and the auto name for the other speaker must survive"
  );
});
