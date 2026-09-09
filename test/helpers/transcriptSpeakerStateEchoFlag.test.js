const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mergeTranscriptSegments,
  parseTranscriptSegments,
  serializeTranscriptSegments,
} = require("../../src/helpers/transcriptSpeakerState");

// Dedupe marks echo bleed instead of deleting it, so the drop rate is only readable
// after the fact if the flag survives the write. Every other bleed signal
// (`likelyRenderBleed`, `hasBleedEvidence`, `suppressionReason`) is dropped at this
// boundary, which is why the defect could not be replayed from stored data.

test("dedupedAsEcho survives a serialize/parse round trip", () => {
  const raw = serializeTranscriptSegments([
    { id: "a", text: "echoed line", source: "mic", timestamp: 10, dedupedAsEcho: true },
    { id: "b", text: "real line", source: "mic", timestamp: 20 },
  ]);

  const parsed = parseTranscriptSegments(raw);

  assert.equal(parsed[0].dedupedAsEcho, true);
  assert.notEqual(parsed[1].dedupedAsEcho, true);
});

test("the echo flag is written to the stored JSON, not only kept in memory", () => {
  const stored = JSON.parse(
    serializeTranscriptSegments([
      { id: "a", text: "echoed line", source: "mic", timestamp: 10, dedupedAsEcho: true },
    ])
  );

  assert.equal(stored[0].dedupedAsEcho, true);
});

test("a merge carries the incoming echo flag onto the stored segment", () => {
  const existing = parseTranscriptSegments(
    serializeTranscriptSegments([{ text: "echoed line", source: "mic", timestamp: 10 }])
  );
  const incoming = [
    {
      id: "diarized-0",
      text: "echoed line",
      source: "mic",
      timestamp: 10,
      speaker: "you",
      dedupedAsEcho: true,
    },
  ];

  const merged = mergeTranscriptSegments(existing, incoming);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].dedupedAsEcho, true);
  assert.equal(merged[0].speaker, "you");
});
