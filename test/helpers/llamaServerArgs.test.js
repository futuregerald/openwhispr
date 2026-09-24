const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const LlamaServerManager = require("../../src/helpers/llamaServer");
const { buildServerArgs } = require("../../src/helpers/llamaServer");
const debugLogger = require("../../src/helpers/debugLogger");

// Every local inference in the app — dictation cleanup, the dictation agent, the
// chat agent, note actions, titles, classification, notes — goes through this one
// server, and an unknown flag makes llama-server exit at startup. So the set of
// flags is pinned here rather than read off the diff.

const base = {
  modelPath: "/models/gemma.gguf",
  port: 8221,
  threads: 4,
  contextSize: 32768,
};

const BASE_ARGS = [
  "--model",
  "/models/gemma.gguf",
  "--host",
  "127.0.0.1",
  "--port",
  "8221",
  "--threads",
  "4",
  "--ctx-size",
  "32768",
  "--jinja",
];

const PLATFORMS = ["darwin", "win32", "linux"];

test("darwin gets flash attention and a quantised KV cache, as adjacent pairs", () => {
  const args = buildServerArgs({ ...base, platform: "darwin", gpu: true });

  for (const [flag, value] of [
    ["-fa", "on"],
    ["-ctk", "q8_0"],
    ["-ctv", "q8_0"],
  ]) {
    const at = args.indexOf(flag);
    assert.notEqual(at, -1, `${flag} missing`);
    assert.equal(args[at + 1], value, `${flag} value`);
  }
});

test("no other platform gets them — those binaries were never measured here", () => {
  for (const platform of ["win32", "linux"]) {
    for (const gpu of [true, false]) {
      const args = buildServerArgs({ ...base, platform, gpu });
      for (const flag of ["-fa", "-ctk", "-ctv"]) {
        assert.equal(args.includes(flag), false, `${platform} gpu=${gpu} passed ${flag}`);
      }
    }
  }
});

test("the base args are byte-identical to what shipped, and GPU layers follow `gpu`", () => {
  for (const platform of PLATFORMS) {
    for (const gpu of [true, false]) {
      const args = buildServerArgs({ ...base, platform, gpu });
      assert.deepStrictEqual(args.slice(0, 11), BASE_ARGS, `${platform} gpu=${gpu}`);

      const at = args.indexOf("--n-gpu-layers");
      if (gpu) {
        assert.equal(at, 11, `${platform}: GPU layers must follow the base args`);
        assert.equal(args[at + 1], "99");
      } else {
        assert.equal(at, -1, `${platform}: GPU layers passed without gpu`);
      }
    }
  }
});

// The three flags the experiment used and this app rejects, with the reasons, so
// that re-adding one means first disagreeing with a measurement:
//
//   --parallel 1 buys no context — the server already reports n_ctx 32768 per
//   slot with 4 auto slots — and it would hurt. llama-server routes a request to
//   the slot whose prompt best matches it, so with four slots an interleaved
//   dictation cleanup lands in a different slot and the debrief's ~9.4k-token
//   prefix stays resident. With one slot it cannot, so the prefix is evicted and
//   re-prefilled (~11 s) on every interleaving. It also turns kv_unified off.
//
//   --cache-ram already defaults to 8192 MiB, so the host-RAM prompt cache is on
//   today by passing nothing. This workload only ever caches ~9.4k tokens
//   (~170-340 MB), so the cap is never reached and lowering it buys nothing —
//   while 0 (the experiment's value, correct for its single-client harness) would
//   remove the cache that restores the prefix after an interleaved request.
//
//   --ctx-checkpoints 8 is a 4x cut below the default of 32, adopted by the
//   experiment while tuning Gemma 12B for memory. No measured upside on E4B.
test("no flag this plan rejected reaches the server, on any platform", () => {
  for (const platform of PLATFORMS) {
    for (const gpu of [true, false]) {
      const args = buildServerArgs({ ...base, platform, gpu });
      for (const flag of [
        "--parallel",
        "-np",
        "--cache-ram",
        "-cram",
        "--ctx-checkpoints",
        "-ctxcp",
      ]) {
        assert.equal(args.includes(flag), false, `${platform} gpu=${gpu} passed ${flag}`);
      }
    }
  }
});

// --- cache_prompt and the cache-hit log -------------------------------------
// The debrief pipeline is only affordable because every call after the first
// reuses the prefill. `cache_prompt` is what buys that, and cache_n is the only
// way to see from a log that it stopped working.

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function completion(timings) {
  const payload = { choices: [{ message: { content: "answer" } }] };
  if (timings) payload.timings = timings;
  return JSON.stringify(payload);
}

async function inferAgainst(responseBody) {
  const seen = { body: null, notices: [] };
  const originalNotice = debugLogger.notice;
  debugLogger.notice = (message, meta) => {
    seen.notices.push({ message, meta });
  };

  try {
    await withServer(
      (req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          seen.body = JSON.parse(raw);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(responseBody);
        });
      },
      async (port) => {
        const manager = new LlamaServerManager();
        manager.port = port;
        manager.ready = true;
        manager.process = {};
        manager.contextSize = 32768;

        seen.text = await manager.inference([{ role: "user", content: "hello" }]);
        manager.clearIdleTimer();
      }
    );
  } finally {
    debugLogger.notice = originalNotice;
  }

  return seen;
}

test("the prompt cache is asked for explicitly, not left to llama.cpp's default", async () => {
  const seen = await inferAgainst(completion({ cache_n: 7442, prompt_n: 61 }));

  assert.equal(seen.body.cache_prompt, true);
});

test("the cache hit is logged, so an evicted prefix is visible in the debug log", async () => {
  const seen = await inferAgainst(completion({ cache_n: 7442, prompt_n: 61 }));

  const notice = seen.notices.find((n) => n.message === "Local inference finished");
  assert.ok(notice, "no completion notice was logged");
  assert.equal(notice.meta.cachedPromptTokens, 7442);
  assert.equal(notice.meta.promptTokens, 61);
});

test("a response without timings still logs and still resolves", async () => {
  for (const body of [completion(null), completion({})]) {
    const seen = await inferAgainst(body);

    assert.equal(seen.text, "answer");
    const notice = seen.notices.find((n) => n.message === "Local inference finished");
    assert.ok(notice, "no completion notice was logged");
    assert.equal(notice.meta.cachedPromptTokens, null);
    assert.equal(notice.meta.promptTokens, null);
  }
});
