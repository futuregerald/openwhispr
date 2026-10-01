export type McpConfigVariant = "read" | "readWrite" | "fallbackRead" | "fallbackReadWrite";

export declare function mcpConfigVariant(options?: {
  fallback?: boolean;
  write?: boolean;
}): McpConfigVariant;
