const isUsableInstant = (value) => typeof value === "number" && Number.isFinite(value);

function markZeroMs({ systemStartedAt = null, firstLocalLineTimestamp = null } = {}) {
  if (isUsableInstant(systemStartedAt)) return systemStartedAt;
  if (isUsableInstant(firstLocalLineTimestamp)) return firstLocalLineTimestamp;
  return null;
}

module.exports = { markZeroMs };
