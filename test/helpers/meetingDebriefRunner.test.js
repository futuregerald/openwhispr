const test = require("node:test");
const assert = require("node:assert");

const { runMeetingDebrief } = require("../../src/helpers/meetingDebriefRunner");
const {
  PROBES,
  SECTIONS,
  ANALYSIS_LABELS,
  KIND_PROMPT_TAIL,
} = require("../../src/helpers/meetingDebriefPrompts");

const coded = (message, code) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

const SEGMENTS = [
  {
    timestamp: 0,
    label: "You",
    text: "How did the migration land?",
    speaker: "you",
    source: "mic",
  },
  {
    timestamp: 42,
    label: "Dana",
    text: "We shipped it in March, two weeks late.",
    speaker: "speaker_0",
    source: "system",
  },
  { timestamp: 95, label: "You", text: "What slipped?", speaker: "you", source: "mic" },
];

// One pass slot per probe and section, plus `kind` — the total the runner reports
// to onProgress, whether or not a gated slot actually runs.
const TOTAL_SLOTS = 1 + PROBES.length + SECTIONS.length;
// `kind: "team"` gates out the verdict probe and the Assessment section, so an
// ungated run is 1 + 10 + 8 = 19 and a team meeting is 1 + 9 + 7 = 17. The plan's
// Phase 3 test list says 20 and 18; its own Phase 1 result table ("The 19 passes
// (not 20) are kind + 10 probes + 8 sections") is the one that matches the code.
const EVALUATION_CALLS = 19;
const TEAM_CALLS = 17;

const isKindPrompt = (prompt) => prompt.includes(KIND_PROMPT_TAIL);
const isSectionPrompt = (prompt) => prompt.includes("END OF ANALYSIS NOTES.");

// Substrings of instructions that carry no {{me}} token, so they survive
// rendering byte for byte and can identify which pass a recorded prompt is.
const PROBE_MARKERS = {
  p_why_now: "Why is this meeting happening now?",
  p_disagree: "For any disagreement described or happening in the meeting",
  p_verdict: "This was an interview or evaluation.",
};
const SECTION_MARKERS = {
  tldr: "3-5 bullets for someone who reads nothing else.",
  context: "One short paragraph: the kind of meeting",
  generic_topics: "One ### subsection per distinct topic",
};

const isProbePrompt = (prompt, name) =>
  !isSectionPrompt(prompt) && prompt.includes(PROBE_MARKERS[name]);

function harness(overrides = {}) {
  const { kindAnswer = "team", reply = null, ...rest } = overrides;
  const calls = [];
  const progress = [];
  const options = {
    segments: SEGMENTS,
    sleep: async () => {},
    onProgress: (p) => progress.push({ ...p }),
    infer: async (prompt, opts) => {
      calls.push({ prompt, opts });
      const custom = reply ? await reply(prompt, opts, calls.length) : undefined;
      if (custom !== undefined) return custom;
      return isKindPrompt(prompt) ? kindAnswer : `out(${calls.length})`;
    },
    ...rest,
  };
  return { calls, progress, options };
}

test("a team meeting runs 17 passes and an interview 19", async () => {
  const team = harness({ kindAnswer: "team" });
  const teamResult = await runMeetingDebrief(team.options);

  assert.equal(team.calls.length, TEAM_CALLS, "the verdict probe and Assessment are gated out");
  assert.equal(teamResult.calls, TEAM_CALLS);
  assert.equal(teamResult.kind, "team");
  assert.equal(teamResult.failedProbes, 0);
  assert.deepEqual(teamResult.skipped, []);
  assert.ok(!teamResult.text.includes("## Assessment"));
  assert.ok(teamResult.text.startsWith("## TL;DR\n\n"));

  const interview = harness({ kindAnswer: "interview" });
  const interviewResult = await runMeetingDebrief(interview.options);

  assert.equal(interview.calls.length, EVALUATION_CALLS, "every probe and section applies");
  assert.equal(interviewResult.calls, EVALUATION_CALLS);
  assert.ok(interviewResult.text.includes("## Assessment"));
  assert.ok(interview.calls.some((c) => isProbePrompt(c.prompt, "p_verdict")));
});

test("the kind gate is a substring test, not equality", async () => {
  // The model answers in a sentence, not the bare word the prompt asked for.
  const h = harness({ kindAnswer: "This was an interview.\n" });
  const result = await runMeetingDebrief(h.options);

  assert.equal(h.calls.length, EVALUATION_CALLS);
  assert.ok(result.text.includes("## Assessment"));
});

test("every prompt after the first shares the transcript prefix byte for byte", async () => {
  const h = harness({ kindAnswer: "interview" });
  await runMeetingDebrief(h.options);

  const marker = "END OF TRANSCRIPT.";
  const first = h.calls[0].prompt;
  const prefix = first.slice(0, first.indexOf(marker) + marker.length);

  assert.ok(prefix.includes("[00:00] You: How did the migration land?"));
  assert.ok(prefix.includes("[00:42] Dana:"));
  for (const call of h.calls) {
    assert.ok(call.prompt.startsWith(prefix), "a drifting prefix costs a full re-prefill per call");
  }

  const sectionPrompts = h.calls.filter((c) => isSectionPrompt(c.prompt)).map((c) => c.prompt);
  const analysisMarker = "END OF ANALYSIS NOTES.";
  const sectionPrefix = sectionPrompts[0].slice(
    0,
    sectionPrompts[0].indexOf(analysisMarker) + analysisMarker.length
  );
  for (const prompt of sectionPrompts) {
    assert.ok(prompt.startsWith(sectionPrefix), "the analysis block must be identical per section");
  }
});

test("a kind pass that never answers is treated as other rather than failing the run", async () => {
  let kindAttempts = 0;
  const h = harness({
    reply: (prompt) => {
      if (!isKindPrompt(prompt)) return undefined;
      kindAttempts += 1;
      throw new Error("boom");
    },
  });

  const result = await runMeetingDebrief(h.options);

  assert.equal(kindAttempts, 4, "an unrecognised error classifies as transient: four attempts");
  assert.equal(result.kind, "other");
  assert.ok(!result.text.includes("## Assessment"));
  assert.ok(!h.calls.some((c) => isProbePrompt(c.prompt, "p_verdict")));
  assert.ok(result.text.includes("## TL;DR"));
});

test("a genuinely failed probe still gets its analysis label, carrying the literal nothing", async () => {
  const h = harness({
    reply: (prompt) => {
      if (isProbePrompt(prompt, "p_disagree")) throw coded("empty", "EMPTY_RESPONSE");
      return undefined;
    },
  });

  const result = await runMeetingDebrief(h.options);
  const sectionPrompt = h.calls.find((c) => isSectionPrompt(c.prompt)).prompt;

  assert.equal(result.failedProbes, 1);
  assert.ok(sectionPrompt.includes("DISAGREEMENTS:\nnothing"), "a failed probe is not omitted");
  assert.ok(sectionPrompt.includes("VERDICT:\nnothing"), "a gated probe is not omitted either");
  assert.ok(sectionPrompt.includes("WHY NOW:\nout(2)"));
  for (const [label] of ANALYSIS_LABELS) {
    assert.ok(sectionPrompt.includes(`${label}:\n`), `${label} must appear in the analysis block`);
  }
});

test("a section that fails is omitted and listed, and the others still ship", async () => {
  const h = harness({
    reply: (prompt) => {
      if (prompt.includes(SECTION_MARKERS.tldr)) throw coded("empty", "EMPTY_RESPONSE");
      return undefined;
    },
  });

  const result = await runMeetingDebrief(h.options);

  assert.deepEqual(result.skipped, ["tldr"]);
  assert.ok(!result.text.includes("## TL;DR"));
  assert.ok(result.text.startsWith("## Meeting Context\n\n"));
  assert.ok(result.text.includes("## Recommendations"));
});

test("a section whose body is NONE is dropped rather than written as a bare heading", async () => {
  const h = harness({
    reply: (prompt) => {
      if (prompt.includes(SECTION_MARKERS.context)) return "none";
      return undefined;
    },
  });

  const result = await runMeetingDebrief(h.options);

  assert.deepEqual(result.skipped, ["context"]);
  assert.ok(!result.text.includes("## Meeting Context"));
  assert.ok(result.text.includes("## TL;DR"));
});

test("an echoed heading is stripped instead of being written twice", async () => {
  // The two shapes the harness regex actually strips. `**TL;DR:**` is not one of
  // them — the colon has to sit outside the asterisks — so a model that bolds it
  // that way keeps its own heading line, in the harness and here alike.
  const h = harness({
    reply: (prompt) => {
      if (prompt.includes(SECTION_MARKERS.tldr)) return "## TL;DR\n\nthe punchline";
      if (prompt.includes(SECTION_MARKERS.context)) return "**Meeting Context**\nthe setting";
      return undefined;
    },
  });

  const result = await runMeetingDebrief(h.options);

  assert.ok(
    result.text.startsWith("## TL;DR\n\nthe punchline\n\n## Meeting Context\n\nthe setting")
  );
  assert.equal(result.text.match(/TL;DR/g).length, 1);
  assert.equal(result.text.match(/Meeting Context/g).length, 1);
});

// The code matters as much as the rejection. Every section failing is only
// reachable when each one failed GENUINELY, so the caller must be told to fall
// back to the chunked path rather than surface an error: LOCAL_MULTIPASS_FAILED
// is in the caller's propagate set and would leave the user with no notes at all.
test("every section failing rejects with a code the caller falls back on", async () => {
  const h = harness({
    reply: (prompt) => {
      if (isSectionPrompt(prompt)) throw coded("empty", "EMPTY_RESPONSE");
      return undefined;
    },
  });

  await assert.rejects(
    () => runMeetingDebrief(h.options),
    (err) => err.code === "LOCAL_DEBRIEF_UNUSABLE"
  );
});

test("a transient failure is retried and a fatal one propagates immediately", async () => {
  let attempts = 0;
  const retried = harness({
    reply: (prompt) => {
      if (!isProbePrompt(prompt, "p_why_now")) return undefined;
      attempts += 1;
      if (attempts === 1) throw coded("busy", "LOCAL_INFERENCE_BUSY");
      return "retried answer";
    },
  });

  const result = await runMeetingDebrief(retried.options);
  assert.equal(attempts, 2);
  assert.equal(result.failedProbes, 0);
  assert.ok(
    retried.calls.find((c) => isSectionPrompt(c.prompt)).prompt.includes("WHY NOW:\nretried answer")
  );

  const fatal = harness({
    reply: () => {
      throw coded("gone", "MODEL_NOT_DOWNLOADED");
    },
  });

  await assert.rejects(
    () => runMeetingDebrief(fatal.options),
    (err) => err.code === "MODEL_NOT_DOWNLOADED"
  );
  assert.equal(fatal.calls.length, 1, "a fatal error on the kind pass is not swallowed or retried");
});

test("cancellation between passes stops further passes", async () => {
  const controller = new AbortController();
  const h = harness({
    reply: (prompt, opts, n) => {
      if (n === 3) controller.abort();
      return undefined;
    },
  });
  h.options.signal = controller.signal;

  await assert.rejects(
    () => runMeetingDebrief(h.options),
    (err) => err.code === "LOCAL_INFERENCE_ABORTED"
  );
  assert.equal(h.calls.length, 3, "no pass may start after cancellation");
});

test("a spent deadline rejects before any section is written", async () => {
  const h = harness({ deadlineMs: 0 });

  await assert.rejects(
    () => runMeetingDebrief(h.options),
    (err) => err.code === "LOCAL_MULTIPASS_TIMEOUT"
  );
  assert.ok(!h.calls.some((c) => isSectionPrompt(c.prompt)));
});

test("progress reports kind then probing then writing, and never goes backwards", async () => {
  const h = harness({ kindAnswer: "interview" });
  await runMeetingDebrief(h.options);

  assert.deepEqual([...new Set(h.progress.map((p) => p.phase))], ["kind", "probing", "writing"]);
  assert.deepEqual([...new Set(h.progress.map((p) => p.total))], [TOTAL_SLOTS]);
  const dones = h.progress.map((p) => p.done);
  assert.deepEqual(
    dones,
    [...dones].sort((a, b) => a - b)
  );
  assert.equal(dones[0], 0);
  assert.equal(dones[dones.length - 1], TOTAL_SLOTS - 1);
});

test("a meeting type template replaces the generic Topics instruction", async () => {
  const h = harness({ meetingTypeTemplate: "### Rounds" });
  await runMeetingDebrief(h.options);

  const topics = h.calls.filter((c) => c.prompt.includes("### Rounds"));
  assert.equal(topics.length, 1);
  assert.ok(topics[0].prompt.includes("**My read:**"));
  assert.ok(!h.calls.some((c) => c.prompt.includes(SECTION_MARKERS.generic_topics)));
});

test("a probe failing genuinely past its limit continues the run", async () => {
  let attempts = 0;
  const h = harness({
    reply: (prompt) => {
      if (!isProbePrompt(prompt, "p_disagree")) return undefined;
      attempts += 1;
      throw coded("empty", "EMPTY_RESPONSE");
    },
  });

  const result = await runMeetingDebrief(h.options);

  assert.equal(attempts, 2, "a genuine failure gets two attempts, not four");
  assert.equal(result.failedProbes, 1);
  assert.equal(h.calls.length, TEAM_CALLS + 1, "the retry is one extra call, not one fewer pass");
  assert.ok(result.text.includes("## TL;DR"));
});

test("a probe failing transiently past every attempt rejects the whole debrief", async () => {
  let attempts = 0;
  const h = harness({
    reply: (prompt) => {
      if (!isProbePrompt(prompt, "p_disagree")) return undefined;
      attempts += 1;
      throw new Error("boom");
    },
  });

  await assert.rejects(
    () => runMeetingDebrief(h.options),
    (err) => err.code === "LOCAL_MULTIPASS_FAILED"
  );
  assert.equal(attempts, 4, "three failed retries mean the machine is broken, not the probe");
});

test("a transient failure is retried with the built-in backoff when no sleep is injected", async () => {
  let attempts = 0;
  const result = await runMeetingDebrief({
    segments: SEGMENTS,
    infer: async (prompt) => {
      attempts += 1;
      if (attempts === 1) throw coded("busy", "LOCAL_INFERENCE_BUSY");
      return isKindPrompt(prompt) ? "team" : "a body";
    },
  });

  assert.equal(result.kind, "team");
  assert.equal(attempts, TEAM_CALLS + 1);
  assert.ok(result.text.includes("## TL;DR"));
});

test("a transcript that renders to nothing is rejected before any inference", async () => {
  const h = harness({ segments: [{ timestamp: 0, label: "You", text: "  um, uh " }] });

  await assert.rejects(
    () => runMeetingDebrief(h.options),
    (err) => err.code === "LOCAL_CONTEXT_EXCEEDED"
  );
  assert.equal(h.calls.length, 0);
});

test("the recorder label the transcript uses is the one the prompts carry", async () => {
  const h = harness({
    segments: [
      { timestamp: 0, label: "Du", text: "Wie war das?", speaker: "you", source: "mic" },
      { timestamp: 20, label: "Dana", text: "Gut.", speaker: "speaker_0", source: "system" },
    ],
  });
  await runMeetingDebrief(h.options);

  assert.ok(h.calls[0].opts.systemPrompt.includes('labelled "Du"'));
  assert.ok(!h.calls.some((c) => c.prompt.includes('("You")')));
});
