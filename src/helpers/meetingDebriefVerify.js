const QUOTED = /[\u00ab"\u201c]([^"\u201c\u201d\n]+(?:\n[^"\u201c\u201d\n]+)?)[\u00bb"\u201d]/g;
const ELLIPSIS = /\s*(?:\.\.\.|\u2026)\s*/;
const CITATION = /\[\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\s*\]/g;
const TRANSCRIPT_STAMP = /\[(\d{2,3}:[0-5]\d)\]/g;
const INTERIOR_RUN = /(?<=\S)[^\S\n]{2,}/g;
const SPACE_BEFORE_PUNCTUATION = / +([,.;:!?)])/g;
const TRAILING_RUN = /[^\S\n]+$/gm;

const normalise = (value) =>
  String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.,;:!?\u2014\u2013-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const canonical = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

function transcriptStamps(transcript) {
  const stamps = new Set();
  for (const [, stamp] of String(transcript ?? "").matchAll(TRANSCRIPT_STAMP)) stamps.add(stamp);
  return stamps;
}

function verifyDebriefSection(body, transcript) {
  const source = normalise(transcript);
  let unverifiedQuotes = 0;

  const text = String(body ?? "").replace(QUOTED, (whole, inner) => {
    const parts = String(inner).split(ELLIPSIS).map(normalise).filter(Boolean);
    if (parts.length > 0 && parts.every((part) => source.includes(part))) return whole;
    unverifiedQuotes += 1;
    return inner;
  });

  const stamps = transcriptStamps(transcript);
  let invalidTimestamps = 0;

  const cited = text.replace(CITATION, (whole, a, b, c) => {
    const seconds =
      c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    const stamp = canonical(seconds);
    if (stamps.has(stamp)) return `[${stamp}]`;
    invalidTimestamps += 1;
    return "";
  });

  const tidied =
    invalidTimestamps === 0
      ? cited
      : cited
          .replace(INTERIOR_RUN, " ")
          .replace(SPACE_BEFORE_PUNCTUATION, "$1")
          .replace(TRAILING_RUN, "");

  return { text: tidied, unverifiedQuotes, invalidTimestamps };
}

module.exports = { verifyDebriefSection };
