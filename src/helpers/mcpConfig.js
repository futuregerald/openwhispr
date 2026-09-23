const fs = require("fs");
const path = require("path");

const WRITE_ENV_VAR = "OPENWHISPR_MCP_WRITE";
const SERVER_NAME = "openwhispr";

function resolveServerPath({ resourcesPath, appPath }) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, "mcp", "server.js"));
  if (appPath) candidates.push(path.join(appPath, "mcp", "server.js"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? null;
}

function resolveExecPath({ platform, execPath, appImagePath }) {
  if (platform === "linux" && appImagePath) return appImagePath;
  return execPath;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildCommands({ serverPath, execPath }) {
  const base = `claude mcp add ${SERVER_NAME} -s user`;
  const write = `-e ${WRITE_ENV_VAR}=1`;
  const quotedServer = quote(serverPath);
  const quotedExec = quote(execPath);

  return {
    read: `${base} -- node ${quotedServer}`,
    readWrite: `${base} ${write} -- node ${quotedServer}`,
    fallbackRead: `${base} -e ELECTRON_RUN_AS_NODE=1 -- ${quotedExec} ${quotedServer}`,
    fallbackReadWrite: `${base} -e ELECTRON_RUN_AS_NODE=1 ${write} -- ${quotedExec} ${quotedServer}`,
    remove: `claude mcp remove ${SERVER_NAME} -s user`,
  };
}

function getMcpConfig({
  resourcesPath = process.resourcesPath,
  appPath = null,
  platform = process.platform,
  execPath = process.execPath,
  appImagePath = process.env.APPIMAGE || null,
  isPackaged = true,
} = {}) {
  const serverPath = resolveServerPath({
    resourcesPath: isPackaged ? resourcesPath : null,
    appPath,
  });
  const resolvedExecPath = resolveExecPath({ platform, execPath, appImagePath });

  return {
    serverName: SERVER_NAME,
    serverPath,
    execPath: resolvedExecPath,
    isPackaged,
    platform,
    writeEnvVar: WRITE_ENV_VAR,
    commands: serverPath ? buildCommands({ serverPath, execPath: resolvedExecPath }) : null,
  };
}

module.exports = { getMcpConfig, buildCommands, resolveServerPath, resolveExecPath, WRITE_ENV_VAR };
