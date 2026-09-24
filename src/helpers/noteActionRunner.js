/**
 * Runs a note action over a transcript that may be far larger than the local
 * model's context, by extracting from each chunk and then composing once.
 *
 * The user's requirement was explicit: a long call must not be cut short. So
 * summary-of-summaries is deliberately avoided — each extraction pulls
 * decisions, owners, numbers and quotes close to verbatim, and the user's real
 * action prompt runs exactly once, over all of them. A prompt that already fits
 * takes a single call and behaves exactly as it did before this module existed.
 *
 * `infer` is injected so this file has no Electron or llama-server dependency
 * and can be exercised under `node --test`.
 */

const {
  chunkSegments,
  chunkText,
  resolveChunkBudget,
  estimateTokens,
} = require("./transcriptPassChunker");
const {
  runnerError,
  throwIfDegrading,
  throwIfPastDeadline,
  throwIfAborted,
  runPass,
} = require("./inferencePassGuards");

const GAP_MARKER = "[extraction unavailable for this section]";

const EXTRACTION_PROMPT = `You are extracting source material from one section of a longer meeting transcript. Another pass will write the final notes from what you return, so nothing you omit can be recovered.

Extract, under these exact headings, only what this section actually contains:

DECISIONS: what was agreed, stated as decided.
ACTION ITEMS: each with its owner and any deadline, exactly as stated.
FACTS AND NUMBERS: figures, dates, names, systems, metrics — verbatim.
OPEN QUESTIONS: anything raised and left unresolved.
NOTABLE QUOTES: short direct quotes that carry weight or commitment.

Rules:
- Quote rather than paraphrase. Preserve exact numbers, names and wording.
- Do not summarise, interpret, or add anything not present in this section.
- Omit a heading entirely if this section has nothing under it.
- No preamble and no closing remarks.`;

const FOLD_PROMPT = `You are merging several extracts from one meeting into a single extract. Keep the same headings. Preserve every decision, action item with its owner and deadline, figure, name and quote exactly as written. Remove only literal duplicates. Do not summarise or shorten anything that is not a duplicate.`;

const EXTRACTION_MAX_TOKENS = 800;
const COMPOSE_MAX_TOKENS = 2048;
const EXTRACTION_TEMPERATURE = 0.1;

const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_GAPS = 3;
const MAX_FOLD_LEVELS = 2;

const renderSegments = (segments) =>
  (segments || [])
    .map((s) => {
      const text = String(s?.text ?? "").trim();
      if (!text) return "";
      const label = String(s?.label ?? "").trim();
      return label ? `${label}: ${text}` : text;
    })
    .filter(Boolean)
    .join("\n");

const hasTranscriptText = (transcript) => Boolean(transcript);

async function foldExtracts({ extracts, budget, infer, sleep, signal, onProgress, passState }) {
  let current = extracts;
  let levels = 0;

  while (levels < MAX_FOLD_LEVELS && estimateTokens(current.join("\n\n")) > budget) {
    const folded = [];
    for (let i = 0; i < current.length; i += 2) {
      const pair = current.slice(i, i + 2);
      if (pair.length === 1) {
        folded.push(pair[0]);
        continue;
      }
      throwIfAborted(signal);
      onProgress?.({ phase: "folding", ...passState() });
      const { text } = await runPass({
        infer,
        prompt: pair.join("\n\n"),
        options: {
          systemPrompt: FOLD_PROMPT,
          maxTokens: EXTRACTION_MAX_TOKENS,
          temperature: EXTRACTION_TEMPERATURE,
        },
        sleep,
        signal,
      });
      folded.push(text ?? pair.join("\n\n"));
    }
    current = folded;
    levels++;
    if (current.length === 1) break;
  }

  return { extracts: current, levels };
}

async function runNoteAction({
  infer,
  noteContent = "",
  segments = [],
  systemPrompt,
  contextSize,
  isGpuBackend = true,
  resumeExtracts = null,
  onProgress = null,
  onExtract = null,
  signal = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const { inputBudget, chunkBudget } = resolveChunkBudget({ contextSize, isGpuBackend });
  // 2048 output tokens against a 2048 context leaves nothing for the prompt.
  const composeMaxTokens = Math.max(
    256,
    Math.min(COMPOSE_MAX_TOKENS, Math.floor(contextSize * 0.3))
  );

  const note = String(noteContent || "").trim();
  const transcript = renderSegments(segments);
  const assembled = [note, transcript ? `## Meeting Transcript\n${transcript}` : ""]
    .filter(Boolean)
    .join("\n\n");

  // The common case. Kept byte-identical to the pre-multi-pass behaviour.
  if (estimateTokens(systemPrompt + assembled) <= inputBudget) {
    onProgress?.({ phase: "composing", currentPass: 1, totalPasses: 1 });
    const { text, error } = await runPass({
      infer,
      prompt: assembled,
      options: { systemPrompt, maxTokens: composeMaxTokens },
      sleep,
      signal,
    });
    if (text == null) throw error;
    return { text, passes: 1, partial: false, gapCount: 0, foldLevels: 0, inputBudget };
  }

  const chunks =
    segments && segments.length > 0
      ? chunkSegments(segments, chunkBudget)
      : chunkText(note, chunkBudget);

  if (chunks.length === 0) {
    throw runnerError("Nothing to process", "LOCAL_CONTEXT_EXCEEDED");
  }

  // Can this run possibly finish? Folding halves the extract count at most
  // MAX_FOLD_LEVELS times, so the smallest compose input this run could ever
  // produce is known before a single pass runs. If even that cannot fit, the
  // run is arithmetically doomed — and proving it over 150 passes and three
  // hours of thrash is strictly worse than saying so now.
  const noteTokensEstimate = estimateTokens(hasTranscriptText(transcript) ? note : "");
  const bestCaseExtracts = Math.ceil(chunks.length / 2 ** MAX_FOLD_LEVELS);
  const bestCaseComposeTokens =
    bestCaseExtracts * EXTRACTION_MAX_TOKENS + noteTokensEstimate + estimateTokens(systemPrompt);
  if (bestCaseComposeTokens > inputBudget) {
    throw runnerError(
      "This note is too long for the local model's available context",
      "LOCAL_CONTEXT_EXCEEDED",
      { chunks: chunks.length, bestCaseComposeTokens, inputBudget, contextSize }
    );
  }

  const totalPasses = chunks.length + 1;
  let currentPass = 0;
  const passState = () => ({ currentPass, totalPasses });

  const extracts = [];
  const passDurations = [];
  let gapCount = 0;
  let consecutiveGaps = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (resumeExtracts && i < resumeExtracts.length) {
      extracts.push(resumeExtracts[i]);
      currentPass++;
      continue;
    }

    throwIfAborted(signal);
    throwIfPastDeadline({ now, startedAt, deadlineMs, currentPass, totalPasses });
    currentPass++;
    onProgress?.({ phase: "extracting", ...passState() });

    const passStartedAt = now();
    const { text } = await runPass({
      infer,
      prompt: chunks[i],
      options: {
        systemPrompt: EXTRACTION_PROMPT,
        maxTokens: EXTRACTION_MAX_TOKENS,
        temperature: EXTRACTION_TEMPERATURE,
      },
      sleep,
      signal,
    });
    const passElapsed = now() - passStartedAt;
    throwIfDegrading({
      durations: passDurations,
      elapsed: passElapsed,
      currentPass,
      totalPasses,
    });
    passDurations.push(passElapsed);

    if (text == null) {
      gapCount++;
      consecutiveGaps++;
      if (consecutiveGaps >= MAX_CONSECUTIVE_GAPS) {
        throw runnerError(
          `Extraction failed on ${MAX_CONSECUTIVE_GAPS} consecutive sections`,
          "LOCAL_MULTIPASS_FAILED",
          { gapCount }
        );
      }
      extracts.push(GAP_MARKER);
      continue;
    }

    consecutiveGaps = 0;
    extracts.push(text);
    onExtract?.(i, text);
  }

  // When there are no segments the note's own text was the material that got
  // chunked, so carrying it into the compose step as well would double it and
  // guarantee an overflow.
  const hasTranscript = Boolean(transcript);
  const notePreamble = hasTranscript && note ? `${note}\n\n` : "";
  const noteTokens = estimateTokens(notePreamble);
  if (noteTokens >= inputBudget) {
    // Folding shrinks extracts, never the note the user wrote by hand.
    throw runnerError(
      "The note's own content is too long for the local model",
      "LOCAL_CONTEXT_EXCEEDED",
      { noteTokens, inputBudget }
    );
  }

  const folded = await foldExtracts({
    extracts,
    budget: inputBudget - noteTokens,
    infer,
    sleep,
    signal,
    onProgress,
    passState,
  });

  const composePrompt = `${notePreamble}${folded.extracts.join("\n\n")}`;
  if (estimateTokens(systemPrompt + composePrompt) > inputBudget) {
    throw runnerError(
      "The extracted material is still too long for the local model",
      "LOCAL_CONTEXT_EXCEEDED",
      { estimatedTokens: estimateTokens(composePrompt), inputBudget }
    );
  }

  throwIfAborted(signal);
  throwIfPastDeadline({ now, startedAt, deadlineMs, currentPass, totalPasses });
  currentPass++;
  onProgress?.({ phase: "composing", ...passState() });

  const { text, error } = await runPass({
    infer,
    prompt: composePrompt,
    options: { systemPrompt, maxTokens: composeMaxTokens },
    sleep,
    signal,
  });
  if (text == null) throw error;

  return {
    text,
    passes: currentPass,
    partial: gapCount > 0,
    gapCount,
    foldLevels: folded.levels,
    inputBudget,
  };
}

module.exports = {
  runNoteAction,
  GAP_MARKER,
  EXTRACTION_PROMPT,
  FOLD_PROMPT,
  EXTRACTION_MAX_TOKENS,
};
