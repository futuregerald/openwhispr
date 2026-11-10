// @ts-check

export const NOTES_LIST_DEFAULT_WIDTH = 208;
export const NOTES_LIST_MIN_WIDTH = 208;
export const NOTES_LIST_MAX_WIDTH = 560;
export const EDITOR_MIN_WIDTH = 360;

/**
 * @param {number} [containerWidth]
 * @returns {number}
 */
export const notesListMaxWidth = (containerWidth) => {
  const hasContainer =
    typeof containerWidth === "number" && Number.isFinite(containerWidth) && containerWidth > 0;
  if (!hasContainer) return NOTES_LIST_MAX_WIDTH;
  return Math.max(
    NOTES_LIST_MIN_WIDTH,
    Math.min(NOTES_LIST_MAX_WIDTH, containerWidth - EDITOR_MIN_WIDTH)
  );
};

/**
 * @param {number} width
 * @param {number} [containerWidth]
 * @returns {number}
 */
export const clampNotesListWidth = (width, containerWidth) => {
  if (!Number.isFinite(width)) return NOTES_LIST_DEFAULT_WIDTH;
  return Math.round(
    Math.max(NOTES_LIST_MIN_WIDTH, Math.min(width, notesListMaxWidth(containerWidth)))
  );
};

/**
 * @param {string | null} raw
 * @returns {number}
 */
export const parseStoredNotesListWidth = (raw) => {
  if (raw === null || raw.trim() === "") return NOTES_LIST_DEFAULT_WIDTH;
  return clampNotesListWidth(Number(raw));
};
