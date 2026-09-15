const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/utils/recordingSpeakerSide.ts");

test("a microphone line is You and a system line is Them", async () => {
  const { recordingSideOf } = await load();

  assert.equal(recordingSideOf({ source: "mic" }), "you");
  assert.equal(recordingSideOf({ source: "system" }), "them");
});

test("a system line carrying a live speaker id and name is still Them", async () => {
  const { recordingSideOf } = await load();

  assert.equal(
    recordingSideOf({ source: "system", speaker: "speaker_7", speakerName: "Alice" }),
    "them"
  );
});

test("a microphone line is You even when something stamped a speaker on it", async () => {
  const { recordingSideOf } = await load();

  assert.equal(recordingSideOf({ source: "mic", speaker: "speaker_2" }), "you");
});

test("a line with no source is Them", async () => {
  const { recordingSideOf } = await load();

  assert.equal(recordingSideOf({}), "them");
  assert.equal(recordingSideOf(null), "them");
});

test("both labels exist in every locale", async () => {
  const { RECORDING_SIDE_LABEL_KEYS } = await load();
  const localesDir = path.join(__dirname, "../../src/locales");

  for (const locale of fs.readdirSync(localesDir)) {
    const file = path.join(localesDir, locale, "translation.json");
    if (!fs.existsSync(file)) continue;
    const translations = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of Object.values(RECORDING_SIDE_LABEL_KEYS)) {
      const value = key.split(".").reduce((node, part) => node?.[part], translations);
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
    }
  }
});
