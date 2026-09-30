const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const debugLogger = require("./debugLogger");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");
const sidecarPidFile = require("./sidecarPidFile");

const PORT_RANGE_START = 6333;
const PORT_RANGE_END = 6350;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
// Slower than audioActivityDetector's 1s base: qdrant costs more to start, and a
// tight respawn loop against a genuinely broken binary is worse than being down.
const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 60 * 1000;
const RESTART_MAX_ATTEMPTS = 5;
// Not a failure count. Across 2,767 measured health-check failures the longest
// consecutive run is 1 -- every failure is followed by a success on the next
// tick -- so any threshold above 1 can never fire. Elapsed time since the last
// success is correct regardless of tick rate. See issue #109 for why those
// alternating failures happen, which is still unexplained.
const DEGRADED_AFTER_MS = 30000;

const STORAGE_DIR = path.join(os.homedir(), ".cache", "openwhispr", "qdrant-data");

class QdrantManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedBinaryPath = null;
    this.stopping = false;
    this.lastSuccessAt = null;
    this.firstStartAt = null;
    this._restartTimer = null;
    this._restartAttempts = 0;
    this._onReadyCallbacks = [];
    this._restartBaseMs = RESTART_BASE_MS;
    this._restartMaxMs = RESTART_MAX_MS;
    this._healthIntervalMs = HEALTH_CHECK_INTERVAL_MS;
    this._degradedAfterMs = DEGRADED_AFTER_MS;
  }

  _spawn(binaryPath, args, options) {
    return spawn(binaryPath, args, options);
  }

  _writeConfig() {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    const configPath = path.join(STORAGE_DIR, "config.yaml");
    const storagePath = path.join(STORAGE_DIR, "storage");
    const configContent = [
      "storage:",
      `  storage_path: ${storagePath}`,
      "service:",
      "  host: 127.0.0.1",
      `  http_port: ${this.port}`,
      `  grpc_port: ${this.port + 1}`,
      "log_level: warn",
      "",
    ].join("\n");

    fs.writeFileSync(configPath, configContent, "utf-8");
    return { configPath, storagePath };
  }

  _findPort() {
    return findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
  }

  onReady(fn) {
    this._onReadyCallbacks.push(fn);
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32" ? `qdrant-${platformArch}.exe` : `qdrant-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getBinaryPath() !== null;
  }

  async start() {
    if (this.firstStartAt === null) this.firstStartAt = Date.now();
    if (this.startupPromise) return this.startupPromise;
    if (this.ready) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart() {
    this.stopping = false;
    const binaryPath = this.getBinaryPath();
    if (!binaryPath) throw new Error("qdrant binary not found");

    this.port = await this._findPort();

    const { configPath, storagePath } = this._writeConfig();

    debugLogger.debug("Starting qdrant", {
      port: this.port,
      binaryPath,
      configPath,
      storagePath,
    });

    this.process = this._spawn(binaryPath, ["--config-path", configPath], {
      cwd: STORAGE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    sidecarPidFile.write("qdrant", this.process.pid);

    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("qdrant stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("qdrant stderr", { data: data.toString().trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("qdrant process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      this.ready = false;
      this.process = null;
      this._stopHealthCheck();
      sidecarPidFile.clear("qdrant");
      if (this.stopping) {
        debugLogger.debug("qdrant stopped", { code });
        return;
      }
      debugLogger.warn("qdrant exited unexpectedly", { code });
      this._scheduleRestart(`exit:${code}`);
    });

    await this._waitForReady(() => ({ stderr: stderrBuffer, exitCode }));
    this._restartAttempts = 0;
    this.lastSuccessAt = Date.now();
    this._startHealthCheck();

    debugLogger.info("qdrant started successfully", { port: this.port });

    for (const fn of this._onReadyCallbacks) {
      try {
        fn(this.port);
      } catch (err) {
        debugLogger.warn("qdrant onReady callback failed", { error: err.message });
      }
    }
  }

  async _waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(`qdrant process died during startup${details ? `: ${details}` : ""}`);
      }

      pollCount++;
      if (await this._checkHealth()) {
        this.ready = true;
        debugLogger.debug("qdrant ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`qdrant failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  _checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/healthz",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this._stopHealthCheck();
        return;
      }
      if (await this._checkHealth()) {
        this.ready = true;
        this.lastSuccessAt = Date.now();
      } else {
        debugLogger.warn("qdrant health check failed");
        this.ready = false;
      }
    }, this._healthIntervalMs);
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  _clearRestartTimer() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  // A sidecar that dies takes semantic search with it, so keep trying to bring
  // it back rather than degrading once and never retrying.
  _scheduleRestart(reason) {
    if (this._restartTimer || this.stopping) return;

    if (this._restartAttempts >= RESTART_MAX_ATTEMPTS) {
      debugLogger.error("qdrant could not be restarted; giving up", {
        attempts: this._restartAttempts,
        reason,
      });
      return;
    }

    this._restartAttempts += 1;
    const delayMs = Math.min(
      this._restartBaseMs * 2 ** (this._restartAttempts - 1),
      this._restartMaxMs
    );
    debugLogger.notice("Scheduling qdrant restart", {
      attempt: this._restartAttempts,
      delayMs,
      reason,
    });

    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.start().catch((err) => {
        debugLogger.warn("qdrant restart attempt failed", { error: err.message });
        this._scheduleRestart("restart-failed");
      });
    }, delayMs);
  }

  async stop() {
    this.stopping = true;
    this._clearRestartTimer();
    this._stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping qdrant");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping qdrant", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
  }

  isReady() {
    return this.ready;
  }

  getPort() {
    return this.port;
  }

  getStatus() {
    // Measured from firstStartAt when nothing has ever succeeded: lastSuccessAt
    // is only set by a passing health check, so a qdrant that never came up
    // would otherwise stay un-degraded forever and never surface a repair.
    const reference = this.lastSuccessAt ?? this.firstStartAt;
    const since = reference === null ? null : Date.now() - reference;
    return {
      available: this.isAvailable(),
      // Deliberately not `this.ready && ...`: a process that is up but failing
      // its health check is exactly the state this snapshot exists to describe.
      running: this.process !== null,
      ready: this.ready,
      port: this.port,
      degraded: since !== null && since > this._degradedAfterMs,
      lastSuccessAt: this.lastSuccessAt,
      restartAttempts: this._restartAttempts,
    };
  }
}

module.exports = QdrantManager;
