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

// The implementation, not the interface declaration above it. Anchoring on the
// bare name matched the `: (patch: ...) => void;` interface line and silently
// asserted against the wrong text.
function storeFunctionBody(name) {
  const store = read("src/stores/settingsStore.ts");
  const marker = `${name}: (patch: { general?: string; dictation?: string }) => {`;
  const start = store.indexOf(marker);
  assert.ok(start > 0, `${name} implementation not found`);
  return store.slice(start, store.indexOf("\n  },", start));
}

test("applyUserContextFromExternal updates the mirror without writing back", () => {
  const body = storeFunctionBody("applyUserContextFromExternal");
  assert.ok(body.includes("localStorage.setItem"), "the localStorage mirror is not updated");
  assert.match(body, /\bset\(/, "the store state is not updated");
  assert.ok(
    !body.includes("setUserContext"),
    "writing back to SQLite from an external apply would loop: the write re-broadcasts"
  );
  assert.ok(
    body.includes("normalizeUserContext"),
    "an externally supplied value must be normalised, not trusted to be within the cap"
  );
});

test("a partial context patch cannot blank the field it omits", () => {
  const body = storeFunctionBody("applyUserContextFromExternal");
  for (const field of ["general", "dictation"]) {
    assert.match(
      body,
      new RegExp(`patch\\?\\.${field} !== undefined`),
      `${field} is not guarded, so a patch carrying only the other field clears it`
    );
  }
  assert.ok(
    !/const \{ general.*\} = patch/.test(body),
    "destructuring with defaults would turn an absent field into an empty string"
  );
});

test("the context subscription is registered and disposed in useSettings", () => {
  const hook = read("src/hooks/useSettings.ts");
  const start = hook.indexOf("onUserContextUpdated");
  assert.ok(start > 0, "the hook never subscribes");
  const effect = hook.slice(start, hook.indexOf("}, [", start) + 40);
  assert.ok(
    effect.includes("applyUserContextFromExternal"),
    "the hook subscribes but applies nothing"
  );
  assert.ok(effect.includes("return unsubscribe"), "the subscription is never disposed");
  assert.ok(
    effect.includes("[applyUserContextFromExternal]"),
    "the effect must depend on the applier, as the dictionary effect does"
  );
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

// --- per-field assertions, so one surviving call cannot satisfy the gate ---
test("each context field is normalised on its own, not just one of them", () => {
  const body = storeFunctionBody("applyUserContextFromExternal");
  for (const [field, kind] of [
    ["general", "general"],
    ["dictation", "dictation"],
  ]) {
    assert.match(
      body,
      new RegExp(`normalizeUserContext\\(patch\\.${field}, "${kind}"\\)`),
      `${field} is stored without normalising, so an over-cap external value is trusted`
    );
  }
});

test("each context field writes its own localStorage mirror", () => {
  const body = storeFunctionBody("applyUserContextFromExternal");
  for (const key of ["generalContext", "dictationContext"]) {
    assert.match(
      body,
      new RegExp(`localStorage\\.setItem\\("${key}"`),
      `${key} is not mirrored, so a reload loses the external write`
    );
  }
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
