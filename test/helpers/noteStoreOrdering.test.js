const test = require("node:test");
const assert = require("node:assert/strict");

async function loadStore(notes) {
  globalThis.window = { electronAPI: { getNotes: async () => notes }, addEventListener: () => {} };
  const mod = await import("../../src/stores/noteStore.ts");
  await mod.initializeNotes();
  return mod;
}

const note = (id, createdAt, extra = {}) => ({
  id,
  title: `n${id}`,
  created_at: createdAt,
  ...extra,
});
const ids = (mod) => mod.getNotesValue().map((n) => n.id);

test("a note whose date moved to today rises to the top of the list", async () => {
  const mod = await loadStore([
    note(3, "2026-11-12 09:00:00"),
    note(2, "2026-11-11 09:00:00"),
    note(1, "2026-11-10 09:00:00"),
  ]);

  mod.updateNoteInStore(note(1, "2026-11-13 15:18:41"));

  assert.deepEqual(ids(mod), [1, 3, 2]);
});

test("a note whose date moved back sinks to its place", async () => {
  const mod = await loadStore([
    note(3, "2026-11-12 09:00:00"),
    note(2, "2026-11-11 09:00:00"),
    note(1, "2026-11-10 09:00:00"),
  ]);

  mod.updateNoteInStore(note(3, "2026-11-01 09:00:00"));

  assert.deepEqual(ids(mod), [2, 1, 3]);
});

test("equal dates order by id, newest first", async () => {
  const mod = await loadStore([note(1, "2026-11-10 09:00:00"), note(2, "2026-11-11 09:00:00")]);

  mod.updateNoteInStore(note(1, "2026-11-11 09:00:00"));

  assert.deepEqual(ids(mod), [2, 1]);
});

test("an edit that leaves the date alone does not reorder the list", async () => {
  const mod = await loadStore([
    note(1, "2026-11-11 09:00:00"),
    note(2, "2026-11-11 09:00:00"),
    note(3, "2026-11-10 09:00:00"),
  ]);

  mod.updateNoteInStore(note(2, "2026-11-11 09:00:00", { title: "renamed" }));

  assert.deepEqual(ids(mod), [1, 2, 3], "the pre-existing order is kept as it was");
  assert.equal(mod.getNotesValue()[1].title, "renamed");
});
