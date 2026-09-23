const MAX_SEARCH_TOKENS = 32;

function buildNoteSearchQuery(input) {
  if (typeof input !== "string") return "";

  const tokens = input
    .normalize("NFC")
    .match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
    ?.filter((token) => /[\p{L}\p{N}]/u.test(token));

  if (!tokens?.length) return "";

  return tokens
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");
}

module.exports = { buildNoteSearchQuery };
