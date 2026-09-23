const process = require("node:process");
const readline = require("node:readline");
const { listTools, callTool } = require("./tools.js");

const SERVER_NAME = "openwhispr";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const PROTOCOL_VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && PROTOCOL_VERSION_SHAPE.test(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

async function handleMessage(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case "notifications/initialized":
      return;

    case "ping":
      respond(id, {});
      return;

    case "tools/list":
      respond(id, { tools: listTools() });
      return;

    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments);
      respond(id, result);
      return;
    }

    default:
      if (isNotification) return;
      respondError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      respondError(null, PARSE_ERROR, "Parse error");
      return;
    }

    handleMessage(message).catch((error) => {
      if (message?.id !== undefined && message?.id !== null) {
        respondError(message.id, INTERNAL_ERROR, error.message);
      }
    });
  });

  rl.on("close", () => {
    process.exitCode = 0;
    process.stdin.pause();
  });
}

if (require.main === module) start();

module.exports = { handleMessage, negotiateProtocolVersion, DEFAULT_PROTOCOL_VERSION };
