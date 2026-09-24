const {
  PROBES,
  SECTIONS,
  ANALYSIS_LABELS,
  KIND_MAX_TOKENS,
  KIND_TEMPERATURE,
  debriefSystemPrompt,
  buildKindPrompt,
  buildProbePrompt,
  buildSectionPrompt,
  topicsInstruction,
  renderDebriefTranscript,
  resolveRecorderLabel,
} = require("./meetingDebriefPrompts");
const {
  runnerError,
  throwIfPastDeadline,
  throwIfAborted,
  runPass,
} = require("./inferencePassGuards");
const { classifyInferenceError } = require("./inferenceErrorClass");

// 10 minutes, not the 30 the chunk-and-fold runner uses: this pipeline's pass
// count is fixed at 19 rather than growing with the transcript, and the slowest
// of 16 measured runs finished in 149s. It is also the only bound on a machine
// that starts swapping mid-run, because throwIfDegrading cannot be used here --
// across those same 16 healthy runs the worst pass-versus-median ratio was 3.76
// against the guard's threshold of 4, so it would abort healthy runs.
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
const UNCLASSIFIED_KIND = "other";
const ABSENT_PROBE_ANSWER = "nothing";
const TOPICS_SECTION = "topics";
const EMPTY_SECTION_BODY = "NONE";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripEchoedHeading = (text, heading) =>
  text.replace(
    new RegExp(
      `^\\s*(#+\\s*)?\\**${escapeRegExp(heading.replace(/^#+\s*/, ""))}\\**:?\\s*\\n`,
      "i"
    ),
    ""
  );

const appliesToKind = (when, kind) =>
  !when || when.contains.some((word) => kind.toLowerCase().includes(word));

const composeAnalysis = (answers) =>
  ANALYSIS_LABELS.map(
    ([label, probeName]) =>
      `${label}:\n${String(answers[probeName] ?? "").trim() || ABSENT_PROBE_ANSWER}`
  ).join("\n\n");

const rethrowIfFatal = (error) => {
  if (classifyInferenceError(error) === "fatal") throw error;
};

const instructionFor = (section, meetingTypeTemplate) =>
  section.name === TOPICS_SECTION ? topicsInstruction(meetingTypeTemplate) : section.instruction;

async function runMeetingDebrief({
  infer,
  segments,
  meetingTypeTemplate = null,
  onProgress = null,
  signal = null,
  // MUST have this default. Without it the first transient failure in production
  // throws `TypeError: sleep is not a function` on the backoff path instead of
  // retrying, and the caller then discards a ~100 s run.
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const transcript = renderDebriefTranscript(segments);
  if (!transcript) throw runnerError("Nothing to process", "LOCAL_CONTEXT_EXCEEDED");

  const recorderLabel = resolveRecorderLabel(segments);
  const systemPrompt = debriefSystemPrompt(recorderLabel);
  const totalPasses = 1 + PROBES.length + SECTIONS.length;
  let donePasses = 0;
  let calls = 0;

  const beforePass = (phase) => {
    throwIfAborted(signal);
    throwIfPastDeadline({ now, startedAt, deadlineMs, currentPass: donePasses, totalPasses });
    onProgress?.({ phase, done: donePasses, total: totalPasses });
  };

  const inferPass = (prompt, options) => {
    calls += 1;
    return runPass({ infer, prompt, options, sleep, signal });
  };

  beforePass("kind");
  let kind = UNCLASSIFIED_KIND;
  try {
    const { text } = await inferPass(buildKindPrompt(transcript, recorderLabel), {
      systemPrompt,
      maxTokens: KIND_MAX_TOKENS,
      temperature: KIND_TEMPERATURE,
    });
    if (text) kind = text;
  } catch (error) {
    rethrowIfFatal(error);
  }
  donePasses += 1;

  const answers = {};
  let failedProbes = 0;
  for (const probe of PROBES) {
    if (appliesToKind(probe.when, kind)) {
      beforePass("probing");
      const { text } = await inferPass(
        buildProbePrompt(transcript, probe.instruction, recorderLabel),
        { systemPrompt, maxTokens: probe.maxTokens, temperature: probe.temperature }
      );
      if (text == null) failedProbes += 1;
      else answers[probe.name] = text;
    }
    donePasses += 1;
  }

  const analysis = composeAnalysis(answers);
  const written = [];
  const skipped = [];

  for (const section of SECTIONS) {
    if (appliesToKind(section.when, kind)) {
      beforePass("writing");
      const { text } = await inferPass(
        buildSectionPrompt(
          transcript,
          analysis,
          instructionFor(section, meetingTypeTemplate),
          recorderLabel
        ),
        { systemPrompt, maxTokens: section.maxTokens, temperature: section.temperature }
      );
      const body = text == null ? "" : stripEchoedHeading(text, section.heading).trim();
      if (body && body.toUpperCase() !== EMPTY_SECTION_BODY) {
        written.push(`${section.heading}\n\n${body}`);
      } else {
        skipped.push(section.name);
      }
    }
    donePasses += 1;
  }

  if (written.length === 0) {
    throw runnerError("Every section of the meeting debrief failed", "LOCAL_MULTIPASS_FAILED", {
      skipped,
    });
  }

  return { text: written.join("\n\n"), calls, skipped, failedProbes, kind };
}

module.exports = { runMeetingDebrief };
