export function parseEventDate(value: string): Date | null {
  if (typeof value !== "string" || !value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dateOnly) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [year, month, day] = dateOnly.slice(1).map(Number);
  const parsed = new Date(year, month - 1, day);
  const rolledOver =
    parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day;
  return rolledOver ? null : parsed;
}

export function normalizeDbDate(dateStr: string): Date {
  if (typeof dateStr !== "string" || !dateStr.trim()) return new Date(NaN);
  const trimmed = dateStr.trim();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const source = hasExplicitZone ? trimmed : `${trimmed}Z`;
  return new Date(source);
}

export function formatUpcomingDateGroup(date: Date | string, t: (key: string) => string): string {
  if (!date) return "";
  const d = typeof date === "string" ? parseEventDate(date) : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return t("controlPanel.history.dateGroups.today");
  if (target.getTime() === tomorrow.getTime()) return t("upcoming.tomorrow");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function formatDateGroup(date: Date | string, t: (key: string) => string): string {
  if (!date) return "";
  const d = typeof date === "string" ? normalizeDbDate(date) : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) return t("controlPanel.history.dateGroups.today");
  if (target.getTime() === yesterday.getTime())
    return t("controlPanel.history.dateGroups.yesterday");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
