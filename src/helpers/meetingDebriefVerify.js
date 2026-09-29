const QUOTED = /[\u00ab"\u201c]([^"\u201c\u201d\n]+(?:\n[^"\u201c\u201d\n]+)?)[\u00bb"\u201d]/g;
const ELLIPSIS = /\s*(?:\.\.\.|\u2026)\s*/;

const normalise = (value) =>
  String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.,;:!?\u2014\u2013-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function verifyDebriefSection(body, transcript) {
  const source = normalise(transcript);
  let unverifiedQuotes = 0;

  const text = String(body ?? "").replace(QUOTED, (whole, inner) => {
    const parts = String(inner).split(ELLIPSIS).map(normalise).filter(Boolean);
    if (parts.length > 0 && parts.every((part) => source.includes(part))) return whole;
    unverifiedQuotes += 1;
    return inner;
  });

  return { text, unverifiedQuotes, invalidTimestamps: 0 };
}

module.exports = { verifyDebriefSection };
