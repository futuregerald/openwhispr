export function mcpConfigVariant({ fallback = false, write = false } = {}) {
  if (fallback) return write ? "fallbackReadWrite" : "fallbackRead";
  return write ? "readWrite" : "read";
}
