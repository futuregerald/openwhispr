// @ts-check

/**
 * @param {unknown} enhancedContent
 * @returns {boolean}
 */
export const hasGeneratedNotes = (enhancedContent) =>
  typeof enhancedContent === "string" && enhancedContent.trim() !== "";

/**
 * @param {unknown} noteType
 * @param {unknown} enhancedContent
 * @returns {"enhanced" | "raw"}
 */
export const defaultNoteViewMode = (noteType, enhancedContent) =>
  noteType === "meeting" && hasGeneratedNotes(enhancedContent) ? "enhanced" : "raw";

/**
 * @param {{
 *   noteType: unknown,
 *   hadGeneratedNotes: boolean,
 *   hasGeneratedNotes: boolean,
 *   viewMode: "raw" | "transcript" | "enhanced",
 *   userChoseView: boolean,
 *   isRecording: boolean,
 * }} state
 * @returns {boolean}
 */
export const shouldOpenArrivedNotes = (state) =>
  state.noteType === "meeting" &&
  !state.hadGeneratedNotes &&
  state.hasGeneratedNotes &&
  state.viewMode !== "enhanced" &&
  !state.userChoseView &&
  !state.isRecording;
