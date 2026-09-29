const QUOTED = /[«"“]([^"“”\n]+(?:\n[^"“”\n]+)?)[»"”]/g;
const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;

const normalise = (value) =>
  String(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,;:!?—–-]/g, " ")
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
