const { formatDebriefTimestamp } = require("./meetingDebriefPrompts");

const QUOTED = /[«"“]([^"“”\n]+(?:\n[^"“”\n]+){0,4})[»"”]/g;
const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;

// Anchored to the start of a line, because renderDebriefTranscript only ever
// emits a stamp there. Unanchored, an [mm:ss] a speaker happened to say out loud
// lands inside a turn's words and whitelists a citation pointing at a moment no
// turn starts at -- and transcript text is untrusted input.
const TRANSCRIPT_STAMP = /^\[(\d{2,3}:[0-5]\d)\] /gm;

// The introducing connector is consumed along with the citation, so removing one
// mid-sentence leaves "Dana said that it slipped" rather than the broken "Dana
// said at that it slipped". The (?!\() keeps a markdown link whose label happens
// to read like a time intact.
const CITED =
  /([^\S\n]*)((?:\b(?:at|around|near|from|by)\b[^\S\n]+|[—–][^\S\n]*)?)\[\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\s*\](?!\()/g;

const BARE_LIST_LINE = /^[^\S\n]*[-*+][^\S\n]*$\n?/gm;

// Below this, a quoted span is far likelier to be a scare quote, a title or a
// term of art than a claim of verbatim speech -- and a span this short matches
// the transcript by coincidence often enough that checking it buys little.
const MIN_QUOTED_WORDS = 4;

const normalise = (value) =>
  String(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,;:!?—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const wordCount = (value) => normalise(value).split(" ").filter(Boolean).length;

function transcriptStamps(transcript) {
  const stamps = new Set();
  for (const [, stamp] of String(transcript ?? "").matchAll(TRANSCRIPT_STAMP)) stamps.add(stamp);
  return stamps;
}

function verifyDebriefSection(body, transcript, userContext = "") {
  const source = `${normalise(transcript)} ${normalise(userContext)}`;
  let unverifiedQuotes = 0;

  const text = String(body ?? "").replace(QUOTED, (whole, inner) => {
    if (wordCount(inner) < MIN_QUOTED_WORDS) return whole;
    const parts = String(inner).replace(CITED, " ").split(ELLIPSIS).map(normalise).filter(Boolean);
    if (parts.length > 0 && parts.every((part) => source.includes(part))) return whole;
    unverifiedQuotes += 1;
    return inner;
  });

  const stamps = transcriptStamps(transcript);
  let invalidTimestamps = 0;

  const cited = text.replace(CITED, (whole, before, connector, a, b, c) => {
    const seconds =
      c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    const stamp = formatDebriefTimestamp(seconds);
    if (stamps.has(stamp)) return `${before}${connector}[${stamp}]`;
    invalidTimestamps += 1;
    return "";
  });

  return {
    text: invalidTimestamps === 0 ? cited : cited.replace(BARE_LIST_LINE, ""),
    unverifiedQuotes,
    invalidTimestamps,
  };
}

module.exports = { verifyDebriefSection };
