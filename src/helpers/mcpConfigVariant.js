export function mcpConfigVariant({ write = false } = {}) {
  return write ? "readWrite" : "read";
}
