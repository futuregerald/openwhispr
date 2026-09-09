// @ts-check

/**
 * @param {string[]} selected
 * @param {string} id
 * @returns {string[]}
 */
export const toggleSpeakerSelection = (selected, id) => {
  const current = Array.isArray(selected) ? selected : [];
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
};

/**
 * @param {string[]} selected
 * @param {string[]} allIds
 * @returns {string[]}
 */
export const toggleSelectAllSpeakers = (selected, allIds) => {
  const ids = Array.isArray(allIds) ? allIds : [];
  const current = Array.isArray(selected) ? selected.filter((id) => ids.includes(id)) : [];
  if (ids.length > 0 && current.length === ids.length) return [];
  return [...current, ...ids.filter((id) => !current.includes(id))];
};

/**
 * @param {string[]} selected
 * @returns {string | null}
 */
export const getMergePrimaryId = (selected) =>
  Array.isArray(selected) && selected.length > 0 ? selected[0] : null;

/**
 * @param {string[]} selected
 * @returns {string[]}
 */
export const getMergeTargetIds = (selected) => (Array.isArray(selected) ? selected.slice(1) : []);

/**
 * @param {string[]} selected
 * @returns {boolean}
 */
export const canMergeSelection = (selected) => Array.isArray(selected) && selected.length >= 2;
