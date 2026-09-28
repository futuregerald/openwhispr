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
const CHARS_PER_TOKEN = 3.6;

export const CONTEXT_BLOCK_MARKERS = [/USER CONTEXT \(/gi, /END OF USER CONTEXT\./gi];

const limitFor = (kind) =>
  kind === "dictation" ? DICTATION_CONTEXT_MAX_CHARS : GENERAL_CONTEXT_MAX_CHARS;

export function normalizeUserContext(value, kind) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, limitFor(kind));
}

export function formatUserContextBlock(value, kind) {
  const text = normalizeUserContext(value, kind).replace(
    new RegExp(CLOSE.replace(/\./g, "\\."), "gi"),
    "[marker removed]"
  );
  if (!text) return "";
  return `\n\n${HEADINGS[kind] || HEADINGS.general}\n\n${text}\n\n${CLOSE}`;
}

export function fitUserContextBlock(value, kind, { budgetTokens, reservedTokens = 0 } = {}) {
  const block = formatUserContextBlock(value, kind);
  if (!block) return "";
  if (budgetTokens === Infinity) return block;
  if (!Number.isFinite(budgetTokens) || !Number.isFinite(reservedTokens)) return "";
  const cost = Math.ceil(block.length / CHARS_PER_TOKEN);
  return reservedTokens + cost <= budgetTokens ? block : "";
}

export const CONTEXT_KIND_FOR_PROMPT = {
  cleanup: "dictation",
  dictationAgent: "dictation",
  chatAgent: null,
};

export function contextKindForPrompt(promptKind) {
  return CONTEXT_KIND_FOR_PROMPT[promptKind] ?? null;
}

export function chooseStoredContext(dbValue, localValue) {
  const db = String(dbValue ?? "").trim();
  const local = String(localValue ?? "").trim();
  if (db) return { value: db, pushToDb: false };
  if (local) return { value: local, pushToDb: true };
  return { value: "", pushToDb: false };
}
