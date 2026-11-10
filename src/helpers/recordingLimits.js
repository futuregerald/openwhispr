"use strict";

const DEFAULT_CAP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_WARN_LEAD_MS = 5 * 60 * 1000;
const MIN_OVERRIDE_CAP_MS = 2 * 60 * 1000;
const CALL_ENDED_NOTICE_MS = 10 * 1000;

function resolveCapMs(raw) {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return DEFAULT_CAP_MS;
  return Math.max(MIN_OVERRIDE_CAP_MS, Math.floor(value));
}

const CAP_MS = resolveCapMs(process.env.OPENWHISPR_RECORDING_CAP_MS);
const WARN_LEAD_MS =
  CAP_MS === DEFAULT_CAP_MS ? DEFAULT_WARN_LEAD_MS : Math.min(DEFAULT_WARN_LEAD_MS, CAP_MS / 2);

module.exports = { CAP_MS, WARN_LEAD_MS, CALL_ENDED_NOTICE_MS };
