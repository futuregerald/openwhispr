const test = require("node:test");
const assert = require("node:assert");

const { modelFitsMemory } = require("../../src/helpers/llamaServer");

const GiB = 1024 ** 3;

const SERVED = [
  {
    ts: "2026-09-08T12:36:58.163Z",
    modelFileBytes: 5405168384,
    availableBytes: 3875504128,
    fileBackedBytes: 3070722048,
    purgeableBytes: 0,
  },
  {
    ts: "2026-09-08T15:12:07.770Z",
    modelFileBytes: 5405168384,
    availableBytes: 5412569088,
    fileBackedBytes: 2665545728,
    purgeableBytes: 11354112,
  },
  {
    ts: "2026-09-08T16:52:24.103Z",
    modelFileBytes: 5405168384,
    availableBytes: 4901208064,
    fileBackedBytes: 3580166144,
    purgeableBytes: 1867776,
  },
  {
    ts: "2026-09-08T19:02:59.271Z",
    modelFileBytes: 5405168384,
    availableBytes: 5409275904,
    fileBackedBytes: 2542845952,
    purgeableBytes: 1310720,
  },
  {
    ts: "2026-09-09T16:02:27.668Z",
    modelFileBytes: 5405168384,
    availableBytes: 4572200960,
    fileBackedBytes: 2544222208,
    purgeableBytes: 12795904,
  },
  {
    ts: "2026-09-09T17:38:00.608Z",
    modelFileBytes: 5405168384,
    availableBytes: 5205360640,
    fileBackedBytes: 2374778880,
    purgeableBytes: 1130496,
  },
  {
    ts: "2026-09-09T19:03:13.842Z",
    modelFileBytes: 5405168384,
    availableBytes: 4770365440,
    fileBackedBytes: 2919694336,
    purgeableBytes: 163627008,
  },
  {
    ts: "2026-09-10T19:02:15.476Z",
    modelFileBytes: 5405168384,
    availableBytes: 5016584192,
    fileBackedBytes: 2256371712,
    purgeableBytes: 14450688,
  },
  {
    ts: "2026-09-10T21:12:34.679Z",
    modelFileBytes: 5405168384,
    availableBytes: 4858314752,
    fileBackedBytes: 2629550080,
    purgeableBytes: 3915776,
  },
  {
    ts: "2026-09-11T15:13:19.529Z",
    modelFileBytes: 5405168384,
    availableBytes: 4779769856,
    fileBackedBytes: 2432466944,
    purgeableBytes: 65536,
  },
  {
    ts: "2026-09-11T19:00:18.962Z",
    modelFileBytes: 5405168384,
    availableBytes: 4428890112,
    fileBackedBytes: 2114600960,
    purgeableBytes: 54378496,
  },
  {
    ts: "2026-09-11T19:44:37.757Z",
    modelFileBytes: 5405168384,
    availableBytes: 4456873984,
    fileBackedBytes: 2284191744,
    purgeableBytes: 111280128,
  },
  {
    ts: "2026-09-14T13:25:58.222Z",
    modelFileBytes: 5405168384,
    availableBytes: 6615580672,
    fileBackedBytes: 6985187328,
    purgeableBytes: 191332352,
  },
  {
    ts: "2026-09-14T15:37:34.651Z",
    modelFileBytes: 5405168384,
    availableBytes: 5777506304,
    fileBackedBytes: 2957197312,
    purgeableBytes: 196608,
  },
  {
    ts: "2026-09-14T17:57:20.887Z",
    modelFileBytes: 5405168384,
    availableBytes: 5643616256,
    fileBackedBytes: 3400564736,
    purgeableBytes: 96960512,
  },
  {
    ts: "2026-09-14T19:03:35.946Z",
    modelFileBytes: 5405168384,
    availableBytes: 7822753792,
    fileBackedBytes: 3566043136,
    purgeableBytes: 84410368,
  },
  {
    ts: "2026-09-15T04:14:15.318Z",
    modelFileBytes: 5405168384,
    availableBytes: 4122509312,
    fileBackedBytes: 3257057280,
    purgeableBytes: 125960192,
  },
  {
    ts: "2026-09-15T15:55:07.909Z",
    modelFileBytes: 5405168384,
    availableBytes: 5654528000,
    fileBackedBytes: 2931113984,
    purgeableBytes: 1376256,
  },
  {
    ts: "2026-09-15T17:27:11.300Z",
    modelFileBytes: 5405168384,
    availableBytes: 5143166976,
    fileBackedBytes: 2375696384,
    purgeableBytes: 171884544,
  },
  {
    ts: "2026-09-15T18:39:40.541Z",
    modelFileBytes: 5405168384,
    availableBytes: 4987715584,
    fileBackedBytes: 3149938688,
    purgeableBytes: 294912,
  },
  {
    ts: "2026-09-15T20:01:07.751Z",
    modelFileBytes: 5405168384,
    availableBytes: 5697683456,
    fileBackedBytes: 2530033664,
    purgeableBytes: 12943360,
  },
  {
    ts: "2026-09-16T14:50:02.741Z",
    modelFileBytes: 5405168384,
    availableBytes: 4528799744,
    fileBackedBytes: 2562572288,
    purgeableBytes: 55459840,
  },
  {
    ts: "2026-09-16T16:15:21.638Z",
    modelFileBytes: 5405168384,
    availableBytes: 4859789312,
    fileBackedBytes: 2548645888,
    purgeableBytes: 156827648,
  },
  {
    ts: "2026-09-16T16:48:56.116Z",
    modelFileBytes: 5405168384,
    availableBytes: 4473176064,
    fileBackedBytes: 2666938368,
    purgeableBytes: 32768,
  },
  {
    ts: "2026-09-16T17:19:07.697Z",
    modelFileBytes: 5405168384,
    availableBytes: 4725260288,
    fileBackedBytes: 2746630144,
    purgeableBytes: 2818048,
  },
  {
    ts: "2026-09-16T19:49:20.042Z",
    modelFileBytes: 5405168384,
    availableBytes: 4859527168,
    fileBackedBytes: 2432221184,
    purgeableBytes: 2572288,
  },
  {
    ts: "2026-09-17T13:03:49.641Z",
    modelFileBytes: 5405168384,
    availableBytes: 3524771840,
    fileBackedBytes: 2343174144,
    purgeableBytes: 75661312,
  },
  {
    ts: "2026-09-17T14:33:52.705Z",
    modelFileBytes: 5405168384,
    availableBytes: 4787961856,
    fileBackedBytes: 2418098176,
    purgeableBytes: 7487488,
  },
  {
    ts: "2026-09-17T15:11:54.308Z",
    modelFileBytes: 5405168384,
    availableBytes: 4874502144,
    fileBackedBytes: 2585411584,
    purgeableBytes: 2736128,
  },
  {
    ts: "2026-09-17T19:19:43.218Z",
    modelFileBytes: 5405168384,
    availableBytes: 5145427968,
    fileBackedBytes: 2465742848,
    purgeableBytes: 184811520,
  },
  {
    ts: "2026-09-17T21:12:14.812Z",
    modelFileBytes: 5405168384,
    availableBytes: 10145710080,
    fileBackedBytes: 8681111552,
    purgeableBytes: 984547328,
  },
  {
    ts: "2026-09-18T15:48:50.624Z",
    modelFileBytes: 5405168384,
    availableBytes: 9146089472,
    fileBackedBytes: 3005628416,
    purgeableBytes: 463765504,
  },
  {
    ts: "2026-09-18T17:13:18.083Z",
    modelFileBytes: 5405168384,
    availableBytes: 6949601280,
    fileBackedBytes: 2941632512,
    purgeableBytes: 212762624,
  },
  {
    ts: "2026-09-18T18:05:22.702Z",
    modelFileBytes: 5405168384,
    availableBytes: 7474446336,
    fileBackedBytes: 2886647808,
    purgeableBytes: 246497280,
  },
  {
    ts: "2026-09-21T15:47:10.641Z",
    modelFileBytes: 5405168384,
    availableBytes: 4702044160,
    fileBackedBytes: 2505146368,
    purgeableBytes: 3883008,
  },
  {
    ts: "2026-09-21T18:50:21.328Z",
    modelFileBytes: 5405168384,
    availableBytes: 5300158464,
    fileBackedBytes: 2728034304,
    purgeableBytes: 344064,
  },
  {
    ts: "2026-09-21T21:16:46.512Z",
    modelFileBytes: 5405168384,
    availableBytes: 5040717824,
    fileBackedBytes: 2816671744,
    purgeableBytes: 1097728,
  },
  {
    ts: "2026-09-22T15:00:01.080Z",
    modelFileBytes: 5405168384,
    availableBytes: 5107171328,
    fileBackedBytes: 2535505920,
    purgeableBytes: 2703360,
  },
  {
    ts: "2026-09-22T15:49:19.064Z",
    modelFileBytes: 5405168384,
    availableBytes: 5082152960,
    fileBackedBytes: 2679635968,
    purgeableBytes: 3801088,
  },
  {
    ts: "2026-09-22T18:01:51.279Z",
    modelFileBytes: 5405168384,
    availableBytes: 4842618880,
    fileBackedBytes: 2551808000,
    purgeableBytes: 94109696,
  },
  {
    ts: "2026-09-22T19:40:26.436Z",
    modelFileBytes: 5405168384,
    availableBytes: 4887543808,
    fileBackedBytes: 2723151872,
    purgeableBytes: 103972864,
  },
  {
    ts: "2026-09-23T15:05:49.173Z",
    modelFileBytes: 5405168384,
    availableBytes: 4856430592,
    fileBackedBytes: 2341076992,
    purgeableBytes: 86835200,
  },
  {
    ts: "2026-09-23T16:08:07.980Z",
    modelFileBytes: 5405168384,
    availableBytes: 4503191552,
    fileBackedBytes: 2305900544,
    purgeableBytes: 65536,
  },
  {
    ts: "2026-09-23T18:46:02.380Z",
    modelFileBytes: 5405168384,
    availableBytes: 4256415744,
    fileBackedBytes: 2576744448,
    purgeableBytes: 5947392,
  },
  {
    ts: "2026-09-23T20:06:20.376Z",
    modelFileBytes: 5405168384,
    availableBytes: 4353589248,
    fileBackedBytes: 2148417536,
    purgeableBytes: 157532160,
  },
  {
    ts: "2026-09-23T21:10:48.130Z",
    modelFileBytes: 5405168384,
    availableBytes: 4680744960,
    fileBackedBytes: 2245066752,
    purgeableBytes: 84705280,
  },
  {
    ts: "2026-09-23T21:44:16.529Z",
    modelFileBytes: 5405168384,
    availableBytes: 3796975616,
    fileBackedBytes: 2334441472,
    purgeableBytes: 113278976,
  },
  {
    ts: "2026-09-25T15:54:09.679Z",
    modelFileBytes: 5405168384,
    availableBytes: 9535176704,
    fileBackedBytes: 8628682752,
    purgeableBytes: 969752576,
  },
  {
    ts: "2026-09-25T16:57:07.948Z",
    modelFileBytes: 5405168384,
    availableBytes: 6020005888,
    fileBackedBytes: 3559899136,
    purgeableBytes: 16334848,
  },
];

const SHORTFALL = [
  {
    ts: "2026-09-24T17:24:38.588Z",
    modelFileBytes: 5405168384,
    availableBytes: 2071232512,
    fileBackedBytes: 1507655680,
    purgeableBytes: 0,
  },
];

// The 13:26 start began after the app had already been killed, so it never
// recorded an outcome. It is a shortfall by the same margin as the 13:24 one.
SHORTFALL.push({
  ts: "2026-09-24T17:26:02.341Z",
  modelFileBytes: 5405168384,
  availableBytes: 2039283712,
  fileBackedBytes: 1489879040,
  purgeableBytes: 0,
});

test("every start that served inference is allowed", () => {
  assert.equal(SERVED.length, 49);
  for (const row of SERVED) {
    const { fits, usableBytes } = modelFitsMemory(row);
    assert.equal(
      fits,
      true,
      `${row.ts} served inference but was refused (usable ${(usableBytes / GiB).toFixed(2)} GiB, model ${(row.modelFileBytes / GiB).toFixed(2)} GiB)`
    );
  }
});

test("both measured shortfalls are refused", () => {
  assert.equal(SHORTFALL.length, 2);
  for (const row of SHORTFALL) {
    const { fits, usableBytes } = modelFitsMemory(row);
    assert.equal(fits, false, `${row.ts} should have been refused`);
    assert.ok(usableBytes < row.modelFileBytes);
  }
});

test("the tightest served start keeps at least 10% headroom", () => {
  const margins = SERVED.map((r) => {
    const { usableBytes } = modelFitsMemory(r);
    return (usableBytes - r.modelFileBytes) / r.modelFileBytes;
  });
  const tightest = Math.min(...margins);
  assert.ok(tightest > 0, "a served start had no headroom");
  // Any safety factor above this would refuse a start that is known to work.
  assert.ok(
    tightest >= 0.099 && tightest < 0.101,
    `tightest headroom was ${(tightest * 100).toFixed(1)}%, expected 10.0%`
  );
});

test("the boundary is inclusive", () => {
  assert.equal(modelFitsMemory({ modelFileBytes: 100, availableBytes: 100 }).fits, true);
  assert.equal(modelFitsMemory({ modelFileBytes: 101, availableBytes: 100 }).fits, false);
});

test("reclaimable pages are counted, and decide the verdict", () => {
  const base = { modelFileBytes: 5 * GiB, availableBytes: 3 * GiB };
  assert.equal(modelFitsMemory(base).fits, false);
  assert.equal(modelFitsMemory({ ...base, fileBackedBytes: 2 * GiB }).fits, true);
  assert.equal(modelFitsMemory({ ...base, purgeableBytes: 2 * GiB }).fits, true);
});

test("missing components count as zero rather than NaN", () => {
  const { fits, usableBytes } = modelFitsMemory({
    modelFileBytes: 100,
    availableBytes: 200,
  });
  assert.equal(usableBytes, 200);
  assert.equal(fits, true);
  assert.ok(Number.isFinite(usableBytes));
});

const { memoryPreflight } = require("../../src/helpers/llamaServer");

const VM_STAT_SHORTFALL = {
  bytes: 2071232512,
  source: "vm_stat",
  components: { fileBacked: 1507655680, purgeable: 0, compressor: 0 },
};

test("a vm_stat probe with components refuses a model that cannot fit", () => {
  const refusal = memoryPreflight({
    modelFileBytes: 5405168384,
    memory: VM_STAT_SHORTFALL,
  });
  assert.ok(refusal, "expected a refusal");
  assert.equal(refusal.usableBytes, 2071232512 + 1507655680);
  assert.equal(refusal.modelFileBytes, 5405168384);
});

test("a vm_stat probe with components allows a model that fits", () => {
  assert.equal(
    memoryPreflight({
      modelFileBytes: 5405168384,
      memory: {
        bytes: 3875504128,
        source: "vm_stat",
        components: { fileBacked: 3070722048, purgeable: 0, compressor: 0 },
      },
    }),
    null
  );
});

// Without components, `usable` collapses to availableBytes alone, and
// os.freemem() reads 0.07 GB on a machine with 3.7 GB reclaimable. Ungated,
// the guard would refuse every local inference on these platforms.
test("the guard is inert wherever the probe reports no components", () => {
  const starved = { modelFileBytes: 5405168384 };
  const cases = [
    {
      label: "linux /proc/meminfo",
      memory: { bytes: 75161927, source: "meminfo", components: null },
    },
    {
      label: "windows os.freemem",
      memory: { bytes: 75161927, source: "os.freemem", components: null },
    },
    {
      label: "darwin fallback",
      memory: { bytes: 75161927, source: "os.freemem", components: null },
    },
    {
      label: "vm_stat without components",
      memory: { bytes: 75161927, source: "vm_stat", components: null },
    },
  ];
  for (const { label, memory } of cases) {
    assert.equal(
      memoryPreflight({ ...starved, memory }),
      null,
      `${label} must not be refused — no component data means no verdict`
    );
  }
});

test("a missing probe result is not a refusal", () => {
  assert.equal(memoryPreflight({ modelFileBytes: 5405168384, memory: null }), null);
  assert.equal(memoryPreflight({ modelFileBytes: 5405168384, memory: undefined }), null);
});
