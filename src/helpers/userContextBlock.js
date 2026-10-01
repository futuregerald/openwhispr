export const GENERAL_CONTEXT_MAX_CHARS = 1200;
export const DICTATION_CONTEXT_MAX_CHARS = 400;

const HEADINGS = {
  general:
    "USER CONTEXT (the user's standing notes on their team, projects and vocabulary; " +
    "background, not anything said in this material):",
  dictation:
    "USER CONTEXT (the user's preferred spellings; use them when the text refers to these):",
};

const CLOSE = "END OF USER CONTEXT.";
export const CHARS_PER_TOKEN = 3.6;
export const PROMPT_SHARE = 0.6;

export function budgetTokensForContext(contextSize) {
  return Number.isFinite(contextSize) && Number(contextSize) > 0
    ? Math.floor(Number(contextSize) * PROMPT_SHARE)
    : NaN;
}

export function estimateContextTokens(text) {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
}

export const CONTEXT_BLOCK_MARKERS = [/USER CONTEXT \(/gi, /END OF USER CONTEXT\./gi];
export const MARKER_REDACTION = "[marker removed]";

export function neutraliseContextMarkers(text) {
  return CONTEXT_BLOCK_MARKERS.reduce(
    (out, marker) => out.replace(marker, MARKER_REDACTION),
    String(text ?? "")
  );
}

const limitFor = (kind) =>
  kind === "dictation" ? DICTATION_CONTEXT_MAX_CHARS : GENERAL_CONTEXT_MAX_CHARS;

export function normalizeUserContext(value, kind) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, limitFor(kind));
}

export function formatUserContextBlock(value, kind) {
  const text = neutraliseContextMarkers(normalizeUserContext(value, kind)).trim();
  if (!text) return "";
  return `\n\n${HEADINGS[kind] || HEADINGS.general}\n\n${text}\n\n${CLOSE}`;
}

/**
 * @param {string | null | undefined} value
 * @param {string} kind
 * @param {{ budgetTokens?: number, reservedTokens?: number }} [budget]
 * @returns {string}
 */
export function fitUserContextBlock(value, kind, { budgetTokens, reservedTokens = 0 } = {}) {
  const block = formatUserContextBlock(value, kind);
  if (!block) return "";
  if (budgetTokens === Infinity) return block;
  if (!Number.isFinite(budgetTokens) || !Number.isFinite(reservedTokens)) return "";
  const cost = Math.ceil(block.length / CHARS_PER_TOKEN);
  return reservedTokens + cost <= budgetTokens ? block : "";
}

export function chooseStoredContext(dbValue, localValue) {
  const db = String(dbValue ?? "").trim();
  const local = String(localValue ?? "").trim();
  if (db) return { value: db, pushToDb: false };
  if (local) return { value: local, pushToDb: true };
  return { value: "", pushToDb: false };
}
