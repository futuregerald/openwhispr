const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PROBES,
  SECTIONS,
  ANALYSIS_LABELS,
  KIND_MAX_TOKENS,
  KIND_TEMPERATURE,
  KIND_PROMPT_TAIL,
  PROBE_PROMPT_TAIL,
  SECTION_PROMPT_TAIL,
  debriefSystemPrompt,
  buildKindPrompt,
  buildProbePrompt,
  buildSectionPrompt,
  topicsInstruction,
  renderDebriefTranscript,
  resolveRecorderLabel,
} = require("../../src/helpers/meetingDebriefPrompts");

const FIXTURES = path.join(__dirname, "..", "fixtures", "debrief-prompts-en");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const pipelineFixture = () => JSON.parse(fixture("pipeline.json"));

const seg = (timestamp, label, text, extra = {}) => ({ timestamp, label, text, ...extra });

test("consecutive turns by the same speaker merge inside 30s and split outside it", () => {
  const merged = renderDebriefTranscript([
    seg(0, "You", "first half"),
    seg(10, "You", "second half"),
  ]);
  assert.equal(merged, "[00:00] You: first half second half");

  const split = renderDebriefTranscript([
    seg(0, "You", "first half"),
    seg(40, "You", "much later"),
  ]);
  assert.equal(split, "[00:00] You: first half\n[00:40] You: much later");

  const differentSpeakers = renderDebriefTranscript([
    seg(0, "You", "a question"),
    seg(5, "Dana", "an answer"),
  ]);
  assert.equal(differentSpeakers, "[00:00] You: a question\n[00:05] Dana: an answer");
});

// The gap is measured against the *last* timestamp folded into the turn, not the
// turn's start, so a run of short segments 20s apart merges without limit. The
// experiment's flatten_compact (run.py:72) compares against the turn's start
// instead and would emit three lines here. Recorded so the divergence is visible.
// The strongest lock in this file: the same segments run through the experiment
// harness's own flatten_compact() produce render-expected.txt byte for byte. That
// harness is what generated the 9-11/11 scores, so any renderer change that alters
// the material the model sees fails here. The fixture exercises filler stripping,
// a merge inside the gap, a split outside it, a speaker change, a blank segment,
// minutes past 60, and a segment that is nothing but filler.
test("the renderer is byte-identical to the harness the prompt set was scored with", () => {
  const segments = JSON.parse(fixture("render-input.json"));
  assert.equal(renderDebriefTranscript(segments), fixture("render-expected.txt"));
  assert.equal(resolveRecorderLabel(segments), "You");
});

// The gap is measured from where the turn STARTED, so a turn can never span
// more than 30s however many short segments fall inside it. Verified against the
// experiment harness that produced the 9-11/11 scores: feeding these exact three
// segments to its flatten_compact() returns "[00:00] You: one two\n[00:40] You:
// three". Measuring from the last folded segment instead would return one line,
// "[00:00] You: one two three", and a real monologue would collapse into a
// single line with a single citable timestamp.
test("the merge gap is measured from where the turn started, not from its last segment", () => {
  const rendered = renderDebriefTranscript([
    seg(0, "You", "one"),
    seg(20, "You", "two"),
    seg(40, "You", "three"),
  ]);
  assert.equal(rendered, "[00:00] You: one two\n[00:40] You: three");
});

test("segments left empty by filler stripping are dropped", () => {
  const rendered = renderDebriefTranscript([
    seg(0, "You", "Um, so the human factor matters, uh, a lot"),
    seg(90, "Dana", "Uh. Um"),
    seg(120, "Dana", "Mm-hmm, hmm, agreed"),
  ]);
  assert.equal(
    rendered,
    "[00:00] You: so the human factor matters, a lot\n[02:00] Dana: agreed",
    "fillers go, 'human' stays, and an all-filler segment is dropped entirely"
  );
});

test("timestamps are zero-padded [mm:ss] and minutes are never wrapped into hours", () => {
  const rendered = renderDebriefTranscript([
    seg(5, "You", "start"),
    seg(65, "Dana", "one minute in"),
    seg(3725, "Dana", "an hour in"),
  ]);
  assert.equal(
    rendered,
    "[00:05] You: start\n[01:05] Dana: one minute in\n[62:05] Dana: an hour in",
    "3725s must render [62:05]; score79.py rejects hh:mm:ss citations"
  );
  assert.doesNotMatch(rendered, /\[\d\d:\d\d:\d\d\]/);
});

test("every probe prompt shares a byte-identical prefix up to its instruction", () => {
  const transcript = "[00:00] You: hello";
  const first = buildProbePrompt(transcript, "QQQ-alpha instruction", "You");
  const second = buildProbePrompt(transcript, "QQQ-beta instruction", "You");

  const prefixOf = (prompt, instruction) => prompt.slice(0, prompt.indexOf(instruction));
  assert.ok(first.includes("QQQ-alpha instruction"));
  assert.equal(
    prefixOf(first, "QQQ-alpha instruction"),
    prefixOf(second, "QQQ-beta instruction"),
    "any drift in the shared prefix costs a full transcript re-prefill per call"
  );
  assert.ok(first.endsWith(PROBE_PROMPT_TAIL.replace("{{me_label}}", "You")));
});

test("every section prompt shares a byte-identical prefix up to its instruction", () => {
  const transcript = "[00:00] You: hello";
  const analysis = "WHY NOW:\nnothing";
  const prefixes = new Set(
    SECTIONS.map((section) => {
      const prompt = buildSectionPrompt(transcript, analysis, section.instruction, "You");
      const at = prompt.indexOf(section.instruction);
      assert.ok(at > 0, `${section.name} instruction must appear in its prompt`);
      return prompt.slice(0, at);
    })
  );
  assert.equal(prefixes.size, 1, "all sections must reuse one cached transcript+analysis prefix");
  const prefix = [...prefixes][0];
  assert.ok(prefix.includes(transcript));
  assert.ok(prefix.includes(analysis));
});

test("topicsInstruction uses the meeting type template when there is one", () => {
  const templated = topicsInstruction("### Rounds\n- who was in the room");
  assert.ok(templated.includes("### Rounds"));
  assert.ok(templated.includes("**My read:**"));

  const generic = topicsInstruction(null);
  assert.ok(!generic.includes("### Rounds"));
  assert.ok(generic.includes("**My read:**"));
  assert.doesNotMatch(generic, /undefined|null/);
  assert.equal(topicsInstruction(""), generic);
  assert.equal(topicsInstruction("   "), generic);

  // The templated form reuses the generic instruction's own **My read:** clause,
  // capitalised because it now opens a sentence.
  const clause = templated.slice(templated.indexOf("Then a line starting"));
  assert.ok(clause.startsWith("Then a line starting **My read:**"));
  assert.ok(generic.endsWith(clause[0].toLowerCase() + clause.slice(1)));
});

test("PROBES and SECTIONS are well-formed and carry no personal name", () => {
  const names = [...PROBES, ...SECTIONS].map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "names must be unique");

  for (const entry of [...PROBES, ...SECTIONS]) {
    assert.ok(entry.instruction.trim().length > 0, `${entry.name} needs an instruction`);
    assert.ok(entry.maxTokens > 0, `${entry.name} needs a positive maxTokens`);
    assert.equal(typeof entry.temperature, "number");
  }
  for (const section of SECTIONS) {
    assert.match(section.heading, /^## \S/);
  }

  const everything = [
    debriefSystemPrompt("{{LABEL}}"),
    KIND_PROMPT_TAIL,
    PROBE_PROMPT_TAIL,
    SECTION_PROMPT_TAIL,
    ...PROBES.map((p) => p.instruction),
    ...SECTIONS.map((s) => `${s.heading}\n${s.instruction}`),
    ...ANALYSIS_LABELS.map((pair) => pair.join(" ")),
  ].join("\n");
  assert.doesNotMatch(everything, /Gerald/i);
  assert.ok(
    !everything.includes('"You"'),
    'the recorder label is a parameter, so no export may hardcode "You"'
  );
});

test("the recorder label is taken from the transcript, never assumed to be You", () => {
  const transcript = "[00:00] Du: hallo";
  for (const label of ["Du", "あなた", "Tú"]) {
    const probe = buildProbePrompt(transcript, PROBES[1].instruction, label);
    const section = buildSectionPrompt(
      transcript,
      "WHY NOW:\nnothing",
      SECTIONS[0].instruction,
      label
    );
    const system = debriefSystemPrompt(label);

    for (const prompt of [probe, section, system]) {
      assert.ok(prompt.includes(`"${label}"`), `${label} must appear as the recorder label`);
      assert.ok(!prompt.includes('("You")'), `${label} run must not claim the recorder is "You"`);
      assert.ok(!prompt.includes('"You"'), `${label} run must not quote "You" at all`);
    }
    assert.ok(probe.includes(`the person who recorded this meeting ("${label}")`));
  }
});

test("resolveRecorderLabel finds the recorder by speaker or source, else null", () => {
  assert.equal(
    resolveRecorderLabel([
      seg(0, "Speaker 1", "hello", { speaker: "speaker_0" }),
      seg(5, "You", "hi", { speaker: "you" }),
    ]),
    "You"
  );
  assert.equal(
    resolveRecorderLabel([seg(0, "Gerald O", "hi", { source: "mic", speakerName: "Gerald O" })]),
    "Gerald O",
    "a mapped speakerName is the recorder's label"
  );
  assert.equal(
    resolveRecorderLabel([
      seg(0, "Speaker 1", "hello", { speaker: "speaker_0", source: "system" }),
      seg(5, "Speaker 2", "hi", { speaker: "speaker_1", source: "system" }),
    ]),
    null
  );
  assert.equal(resolveRecorderLabel([]), null);
  assert.equal(resolveRecorderLabel(null), null);
  assert.equal(
    resolveRecorderLabel([seg(0, "   ", "hi", { speaker: "you" })]),
    null,
    "a blank label is no label"
  );
});

// The Phase 1 experiment scored these exact strings 9-11/11. Templating them is
// only safe while an English run reproduces them byte for byte.
test("with the label You the built prompts equal the Phase 1 validated fixtures", () => {
  const pipeline = pipelineFixture();
  const transcript = "[00:00] You: hello\n[00:40] Dana: hi";
  const analysis = "WHY NOW:\nnothing\n\nUNASKED:\nnothing";

  assert.equal(debriefSystemPrompt("You"), fixture("system.txt"));

  assert.equal(
    buildKindPrompt(transcript, "You"),
    fixture("kind.md").replace("{{transcript}}", transcript)
  );
  assert.equal(KIND_MAX_TOKENS, pipeline.passes.kind.max_tokens);
  assert.equal(KIND_TEMPERATURE, pipeline.passes.kind.temperature);

  const probeNames = Object.keys(pipeline.passes).filter((name) => name.startsWith("p_"));
  assert.deepEqual(
    PROBES.map((probe) => probe.name),
    probeNames
  );
  for (const probe of PROBES) {
    const expected = pipeline.passes[probe.name];
    assert.equal(probe.maxTokens, expected.max_tokens, `${probe.name} maxTokens`);
    assert.equal(probe.temperature, expected.temperature, `${probe.name} temperature`);
    assert.deepEqual(probe.when, expected.when, `${probe.name} when`);
    assert.equal(
      buildProbePrompt(transcript, probe.instruction, "You"),
      fixture("probe.md")
        .replace("{{transcript}}", transcript)
        .replace("{{instruction}}", expected.instruction),
      `${probe.name} probe prompt must match the validated fixture`
    );
  }

  assert.deepEqual(
    SECTIONS.map((section) => section.name),
    pipeline.assemble
  );
  for (const section of SECTIONS) {
    const expected = pipeline.passes[section.name];
    assert.equal(section.heading, expected.heading, `${section.name} heading`);
    assert.equal(section.maxTokens, expected.max_tokens, `${section.name} maxTokens`);
    assert.equal(section.temperature, expected.temperature, `${section.name} temperature`);
    assert.deepEqual(section.when, expected.when, `${section.name} when`);
    const instruction = section.name === "topics" ? topicsInstruction(null) : section.instruction;
    assert.equal(
      buildSectionPrompt(transcript, analysis, instruction, "You"),
      fixture("section.md")
        .replace("{{transcript}}", transcript)
        .replace("{{analyze}}", analysis)
        .replace("{{instruction}}", expected.instruction),
      `${section.name} section prompt must match the validated fixture`
    );
  }

  assert.deepEqual(ANALYSIS_LABELS, pipeline.passes.analyze.compose);
});
