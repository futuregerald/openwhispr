export const NOTES_LIST_DEFAULT_WIDTH: number;
export const NOTES_LIST_MIN_WIDTH: number;
export const NOTES_LIST_MAX_WIDTH: number;
export const EDITOR_MIN_WIDTH: number;
export function notesListMaxWidth(containerWidth?: number): number;
export function clampNotesListWidth(width: number, containerWidth?: number): number;
export function parseStoredNotesListWidth(raw: string | null): number;
