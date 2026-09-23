const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message) {
  const error = new Error(message);
  error.code = "VALIDATION";
  return error;
}

const MAX_SAFE_EPOCH_MS = 8.64e15;

function toSqlUtc(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function toLocalDate(ms) {
  const local = new Date(ms);
  const year = String(local.getFullYear()).padStart(4, "0");
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function bound(ms) {
  return { ms, sql: toSqlUtc(ms), localDate: toLocalDate(ms) };
}

function resolveDateBound(value, { exclusiveEnd = false } = {}) {
  if (value == null || value === "") return null;

  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_SAFE_EPOCH_MS) {
      throw validationError(`Invalid date: ${value}`);
    }
    return bound(ms);
  }

  const raw = String(value).trim();

  if (BARE_DATE.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const probe = new Date(year, month - 1, day);
    if (
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      throw validationError(`Invalid date: ${value}`);
    }
    const local = new Date(year, month - 1, day + (exclusiveEnd ? 1 : 0));
    return bound(local.getTime());
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw validationError(`Invalid date: ${value}`);
  return bound(ms);
}

function resolveDateRange(since, until) {
  const from = resolveDateBound(since);
  const to = resolveDateBound(until, { exclusiveEnd: true });
  if (from && to && from.ms > to.ms) {
    throw validationError("since must not be later than until");
  }
  return { from, to };
}

module.exports = { resolveDateBound, resolveDateRange, toSqlUtc };
