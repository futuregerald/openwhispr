export type McpConfigVariant = "read" | "readWrite";

export declare function mcpConfigVariant(options?: { write?: boolean }): McpConfigVariant;
