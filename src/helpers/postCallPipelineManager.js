const fs = require("fs");
const debugLogger = require("./debugLogger");
const { computeTranscriptDiff } = require("./transcriptDiff");
const { retranscribeNoteTranscript } = require("./retranscribeNoteTranscript");
const { i18nMain, SUPPORTED_UI_LANGUAGES } = require("./i18nMain");
const { MainProcessInference } = require("./mainProcessInference");
const { runNoteAction } = require("./noteActionRunner");
const { resolveSpeaker, buildSpeakerMappings } = require("./transcriptFormatter");
const {
  CHARS_PER_TOKEN,
  MIN_CONTEXT,
  PROMPT_SHARE,
  estimatePromptTokens,
} = require("./llamaContext");
const {
  PROBES,
  SECTIONS,
  buildSectionPrompt,
  renderDebriefTranscript,
  resolveRecorderLabel,
  topicsInstruction,
} = require("./meetingDebriefPrompts");
const { runMeetingDebrief } = require("./meetingDebriefRunner");

const STEP_ORDER = ["retranscribe", "classify", "title", "notes"];

// STEP_ORDER.indexOf returns -1 for anything unrecognised, and -1 <= 0, so an
// unvalidated fromStep silently ran the ENTIRE pipeline including
// re-transcription -- the most expensive thing the app does, in response to a
// typo. Callers validate first.
function isPipelineStep(step) {
  return STEP_ORDER.includes(step);
}

const TITLE_PLACEHOLDER_KEYS = [
  "notes.list.untitledNote",
  "notes.list.newNote",
  "notes.sidebar.newNote",
];

let cachedTitlePlaceholders = null;

// A note may have been created while the app was in a different language than
// the one running now, so recognising only the current locale's placeholder
// would stop title generation for anyone who ever switched languages — and for
// every non-English user, since the built-in list is English.
function localizedTitlePlaceholders() {
  if (cachedTitlePlaceholders) return cachedTitlePlaceholders;
  const placeholders = new Set();
  for (const lng of SUPPORTED_UI_LANGUAGES) {
    for (const key of TITLE_PLACEHOLDER_KEYS) {
      const label = i18nMain.t(key, { lng });
      if (typeof label === "string" && label.trim()) placeholders.add(label.trim());
    }
  }
  cachedTitlePlaceholders = [...placeholders];
  return cachedTitlePlaceholders;
}

function buildTypedNotesPrompt(meetingType) {
  return `You are a sharp, thorough meeting notes assistant that captures not just what was said, but what it means. You will receive a transcript with speaker labels.

Meeting type: ${meetingType.name}

Produce notes in the following structure. Start with the standard sections, then follow the type-specific template.

## TL;DR
3-5 bullets. Lead each with **topic in bold**, then what happened + the "so what." Flag urgent items last with **[Urgent]**.

## Meeting Overview
One short paragraph: purpose of this meeting, who was there (list all speakers by name), and overall tone.

## Topics Covered
${meetingType.template}

## Decisions & Open Items
- **Decided:** [list decisions]
- **Still open:** [list unresolved items]

## Action Items
Use checkboxes. Attribute to the responsible person. Include deadlines if mentioned.
- [ ] **[Person]:** [Specific action] — [deadline if stated]

## Key Takeaways
2-3 sentences of honest analysis: implications, risks, soft commitments, things carefully avoided or left unsaid.

FORMAT RULES (strict):
- Do NOT repeat the meeting title — the app already shows it.
- Do NOT use tables, horizontal rules, or block quotes.
- Use markdown headings (##, ###) and bullet points for scannability.
- Keep the tone professional but direct. Capture meaning and sentiment, not just words.
- Refer to each person by exactly the label the transcript uses. Never present a \`Speaker N\` label and a name as one identity. If someone is named only in what was said, write it as \`Speaker 3 (introduced themselves as Jay)\` so the reader can see the name came from the conversation and not from voice identification.
- Preserve important quotes or commitments verbatim when they carry weight.`;
}

const GENERIC_NOTES_PROMPT = `You are a sharp, thorough meeting notes assistant that captures not just what was said, but what it means. You will receive a transcript with speaker labels.

Produce notes in the following structure. Every section is mandatory — omit a section ONLY if it truly has zero content.

## TL;DR
3-5 bullets maximum. Written for someone who will read nothing else.
- Lead each bullet with the **topic in bold**, then what happened + the "so what" (not just "discussed X" but "discussed X, agreed to Y, [Person] needs to do Z")
- If there's a time-sensitive item, flag it last with **[Urgent]**

## Meeting Overview
One short paragraph: what was the purpose of this meeting, who was there (list all speakers by name), and the overall tone (e.g., collaborative, tense, productive, exploratory). This orients the reader.

## Topics Covered
One subsection per distinct topic. Order by importance, not chronology.

For each topic:
### [Topic Name]
**What was discussed:** Concise summary — who said what, positions taken, information shared. Use speaker names.
**Decisions made:** Bullet list of decisions, or "None" if the topic was discussed but nothing was decided.
**Open questions:** Anything unresolved, deferred, or needing follow-up.

## Decisions & Open Items
Quick-reference summary:
- **Decided:** [list decisions made]
- **Still open:** [list unresolved items, deferred questions]

## Action Items
Use checkboxes. Attribute each item to the responsible person where clear. Include deadlines if mentioned.
- [ ] **[Person]:** [Specific action] — [deadline if stated]

## Key Takeaways
2-3 sentences of honest analysis: What does this meeting mean? What are the implications? Are there risks, soft commitments, or things that were carefully avoided? This is the "read between the lines" section — note hedging, enthusiasm gaps, or topics that probably should have been raised but weren't.

FORMAT RULES (strict):
- Do NOT repeat the meeting title — the app already shows it.
- Do NOT use tables, horizontal rules, or block quotes.
- Use markdown headings (##, ###) and bullet points for scannability.
- Keep the tone professional but direct. Capture meaning and sentiment, not just words.
- Consolidate repeated points — don't echo every utterance.
- Refer to each person by exactly the label the transcript uses. Never present a \`Speaker N\` label and a name as one identity. If someone is named only in what was said, write it as \`Speaker 3 (introduced themselves as Jay)\` so the reader can see the name came from the conversation and not from voice identification.
- Preserve important quotes or specific commitments verbatim when they carry weight.`;

const TITLE_PROMPT = `Generate a concise 3-8 word title for this meeting. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.

You are given a participant roster and excerpts from the beginning, middle and end of the meeting. Use all of it. The opening minutes are usually greetings, logistics and audio checks, and almost never describe what the meeting was actually for.

When the meeting is between two people, name the other person — "1:1 with Mike" beats "Discussion About Projects". Never present a \`Speaker N\` label and a name as one identity, and never put a bare \`Speaker N\` in a title; if nobody is identified by name, describe the subject instead.`;

// Must not become a flat number. The title step is fatal to the run
// (`if (titleResult.error) return;`) and a local model refuses a prompt over
// `contextSize * PROMPT_SHARE` -- 1228 tokens at the 2048 floor -- so a fixed
// 6k digest costs the user their notes as well as their title.
const CLOUD_DIGEST_CHARS = 6000;
const LEGACY_DIGEST_CHARS = 2000;
const DIGEST_BUDGET_MARGIN = 0.85;
const MAX_ROSTER_NAMES = 8;

const DEBRIEF_TOPICS_SECTION = "topics";

const DEBRIEF_PROPAGATED_ERROR_CODES = new Set([
  "LOCAL_INFERENCE_ABORTED",
  "LOCAL_MULTIPASS_FAILED",
  "LOCAL_MULTIPASS_TIMEOUT",
  "LOCAL_MULTIPASS_DEGRADED",
]);

const DEBRIEF_WORST_CASE_ANALYSIS = "x".repeat(
  Math.ceil(PROBES.reduce((tokens, probe) => tokens + probe.maxTokens, 0) * CHARS_PER_TOKEN)
);

function longestDebriefSectionInstruction(meetingTypeTemplate) {
  return SECTIONS.map((section) =>
    section.name === DEBRIEF_TOPICS_SECTION
      ? topicsInstruction(meetingTypeTemplate)
      : section.instruction
  ).reduce((longest, instruction) => (instruction.length > longest.length ? instruction : longest));
}

const debriefSubStageFor = (phase) => (phase === "writing" ? "writing" : "analyzing");

class PostCallPipelineManager {
  constructor({
    broadcast,
    databaseManager,
    whisperManager,
    diarizationManager,
    inference,
    convertToWav,
    resolveModelContext = null,
  }) {
    this._broadcast = broadcast;
    this._db = databaseManager;
    this._whisper = whisperManager;
    this._diarization = diarizationManager;
    this._inference = inference;
    this._convertToWav = convertToWav;
    // Absent in the tests that construct this manager directly, and absent for
    // any caller with no local model available; both fall back to one call.
    this._resolveModelContext = resolveModelContext;
  }

  async run(noteId, options = {}) {
    const note = this._db.getNote(noteId);
    if (!note) {
      this._emitStatus(noteId, "retranscribe", "error", "Note not found");
      return;
    }

    const fromIndex = options.fromStep ? STEP_ORDER.indexOf(options.fromStep) : 0;
    let transcript = note.transcript;

    // Step 1: Re-transcribe
    if (fromIndex <= 0) {
      const result = await this._retranscribeStep(noteId, note);
      if (result.error) return;
      if (result.transcript) {
        transcript = result.transcript;
      }
    }

    // Step 2: Classify meeting type (non-fatal — errors don't halt pipeline)
    if (fromIndex <= 1) {
      try {
        const classifyResult = await this._runStep(noteId, "classify", () =>
          this._classifyMeetingType(noteId, this._transcriptAsOfNow(noteId, transcript))
        );
        if (!classifyResult.error && classifyResult.value) {
          this._db.updateNote(noteId, { meeting_type_id: classifyResult.value });
          this._broadcastNoteUpdate(noteId);
        }
      } catch (err) {
        debugLogger.warn("Pipeline: classify step failed (non-fatal)", { noteId, error: err.message }, "meeting");
        this._emitStatus(noteId, "classify", "error", err.message);
      }
    }

    // Step 3: Generate title
    //
    // Guarded twice on purpose. The first check keeps "reprocess all meetings"
    // from spending one title call per note on the user's own API key only to
    // discard every result; the second closes the race the first cannot, since
    // re-transcription runs for minutes and the user can title the note in that
    // window.
    if (fromIndex <= 2) {
      if (await this._mayGenerateTitle(noteId)) {
        const titleResult = await this._runStep(noteId, "title", () =>
          this._generateTitle(noteId, this._transcriptAsOfNow(noteId, transcript))
        );
        if (titleResult.error) return;
        if (titleResult.value && (await this._mayGenerateTitle(noteId))) {
          this._db.updateNote(noteId, { title: titleResult.value });
          this._broadcastNoteUpdate(noteId);
        }
      } else {
        this._emitStatus(noteId, "title", "skipped");
      }
    }

    // Step 4: Generate notes
    if (fromIndex <= 3) {
      const notesResult = await this._runStep(noteId, "notes", () =>
        this._generateNotes(noteId, this._transcriptAsOfNow(noteId, transcript))
      );
      if (notesResult.error) return;
      if (notesResult.value) {
        this._db.updateNote(noteId, { enhanced_content: notesResult.value });
        this._broadcastNoteUpdate(noteId);
      }
    }

    this._emitStatus(noteId, "pipeline", "complete");
  }

  async runSingleStep(noteId, step) {
    const note = this._db.getNote(noteId);
    if (!note) {
      this._emitStatus(noteId, step, "error", "Note not found");
      return;
    }

    const transcript = note.transcript || note.content;

    if (step === "notes") {
      const result = await this._runStep(noteId, "notes", () =>
        this._generateNotes(noteId, transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { enhanced_content: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    } else if (step === "classify") {
      const result = await this._runStep(noteId, "classify", () =>
        this._classifyMeetingType(noteId, transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { meeting_type_id: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    } else if (step === "title") {
      const result = await this._runStep(noteId, "title", () =>
        this._generateTitle(noteId, transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { title: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    }

    this._emitStatus(noteId, "pipeline", "complete");
  }

  // Reads the note itself rather than trusting run()'s snapshot: re-transcription
  // can run for minutes with the large model, so that snapshot is long stale.
  //
  // Any failure answers "no". The database is closed when the app quits, which
  // can land inside a run this long, and an escaping exception would abandon
  // classify and notes with no terminal status — leaving the renderer on a
  // title:complete for a title that was never written.
  async _mayGenerateTitle(noteId) {
    try {
      const { isRegenerableNoteTitle } = await import("./regenerableNoteTitle.js");
      const note = this._db.getNote(noteId);
      if (!note) return false;

      let calendarEventName = null;
      if (note.calendar_event_id) {
        const event = this._db.getCalendarEventById?.(note.calendar_event_id);
        calendarEventName = event?.summary || null;
      }

      return isRegenerableNoteTitle(note.title, localizedTitlePlaceholders(), calendarEventName);
    } catch (err) {
      debugLogger.warn(
        "Pipeline: title guard could not read the note, keeping the existing title",
        { noteId, error: err.message },
        "meeting"
      );
      return false;
    }
  }

  async _runStep(noteId, step, fn) {
    this._emitStatus(noteId, step, "running");
    try {
      const value = await fn();
      this._emitStatus(noteId, step, "complete");
      return { value };
    } catch (err) {
      debugLogger.error(`Pipeline step ${step} failed`, { noteId, error: err.message }, "meeting");
      this._emitStatus(noteId, step, "error", err.message);
      return { error: err.message };
    }
  }

  // Re-transcription must never trade a structured, speaker-labelled transcript for a
  // plain-text blob. The shared module either produces segments that preserve the
  // speaker identities or declines, and this step only persists the former.
  async _retranscribeStep(noteId, note) {
    const hasAudio = [note.system_audio_path, note.mic_audio_path].some(
      (audioPath) => audioPath && fs.existsSync(audioPath)
    );
    if (!hasAudio) {
      this._emitStatus(noteId, "retranscribe", "skipped");
      return {};
    }

    this._emitStatus(noteId, "retranscribe", "running");

    let result;
    try {
      result = await retranscribeNoteTranscript({
        note,
        whisperManager: this._whisper,
        diarizationManager: this._diarization,
        databaseManager: this._db,
        convertToWav: this._convertToWav,
        onSubStage: (subStage) => this._emitSubStage(noteId, "retranscribe", subStage),
        reloadNote: () => this._db.getNote(noteId),
      });
    } catch (err) {
      debugLogger.error(
        "Pipeline step retranscribe failed",
        { noteId, error: err.message },
        "meeting"
      );
      this._emitStatus(noteId, "retranscribe", "error", err.message);
      return { error: err.message };
    }

    if (result.outcome === "model-missing") {
      // Deliberately no "complete" here: the step has not run, and the note must stay
      // pending until the model download drains it.
      this._broadcast("post-call-pipeline-status", {
        noteId,
        step: "retranscribe",
        status: "pending",
      });
      return {};
    }

    if (result.outcome === "preserved") {
      this._db.updateNote(noteId, { retranscribe_outcome: result.reason });
      this._broadcast("post-call-pipeline-status", {
        noteId,
        step: "retranscribe",
        status: "complete",
        preserved: true,
        reason: result.reason,
      });
      this._broadcastNoteUpdate(noteId);
      // The kept transcript still covers every source, so it stays the better input for
      // the title, classification and notes that follow.
      return {};
    }

    const previousTranscript = this._db.getNote(noteId)?.transcript;
    this._db.updateNote(noteId, {
      transcript: result.transcript,
      retranscribe_outcome: null,
      transcript_origin_ms: null,
      transcript_origin_source: "unanchored",
    });

    this._broadcast("post-call-pipeline-status", {
      noteId,
      step: "retranscribe",
      status: "complete",
      diff: computeTranscriptDiff(previousTranscript, result.transcript),
    });
    this._broadcastNoteUpdate(noteId);

    return { transcript: result.transcript };
  }

  async _generateTitle(noteId, transcript) {
    const config = this._getInferenceConfig();
    if (!config) return null;

    const systemPrompt = this._buildTitlePrompt(noteId);
    const budget = await this._digestBudget(config, systemPrompt);

    let title;
    try {
      title = await this._inference.processText(
        this._transcriptDigest(noteId, transcript, budget),
        { ...config, systemPrompt, temperature: 0.3 }
      );
    } catch (err) {
      if (err?.code !== "LOCAL_CONTEXT_EXCEEDED") throw err;
      debugLogger.warn(
        "Pipeline: title digest overran the local context, retrying smaller",
        { noteId, budget },
        "meeting"
      );
      title = await this._inference.processText(
        this._transcriptDigest(noteId, transcript, LEGACY_DIGEST_CHARS),
        { ...config, systemPrompt, temperature: 0.3 }
      );
    }

    const cleaned = title.trim().replace(/^["']|["']$/g, "");
    return cleaned.length > 0 && cleaned.length < 100 ? cleaned : null;
  }

  _buildTitlePrompt(noteId) {
    const typeName = this._meetingTypeName(noteId);
    return typeName
      ? `${TITLE_PROMPT}\n\nThis meeting has already been classified as "${typeName}". Let that shape the title.`
      : TITLE_PROMPT;
  }

  _meetingTypeName(noteId) {
    try {
      const typeId = this._db.getNote(noteId)?.meeting_type_id;
      if (!typeId) return null;
      return this._db.getMeetingType?.(typeId)?.name || null;
    } catch {
      return null;
    }
  }

  async _digestBudget(config, systemPrompt) {
    const servedLocally =
      MainProcessInference.resolveProvider(config.provider, config.model) === "local";
    if (!servedLocally || !this._resolveModelContext) return CLOUD_DIGEST_CHARS;

    try {
      const { contextSize } = await this._resolveModelContext(config.model);
      const budgetTokens = Math.floor((contextSize || MIN_CONTEXT) * PROMPT_SHARE);
      const available =
        Math.floor(budgetTokens * CHARS_PER_TOKEN * DIGEST_BUDGET_MARGIN) - systemPrompt.length;
      return Math.max(0, Math.min(CLOUD_DIGEST_CHARS, available));
    } catch {
      return LEGACY_DIGEST_CHARS;
    }
  }

  _transcriptDigest(noteId, transcript, budgetChars) {
    const segments = this._transcriptSegments(noteId, transcript);
    const roster = this._participantRoster(segments);
    const rosterLine = roster ? `Participants: ${roster}\n\n` : "";

    const lines =
      segments.length > 0
        ? segments.map((s) => (s.label ? `${s.label}: ${s.text}` : s.text))
        : this._plainTextLines(this._flattenTranscript(noteId, transcript));

    const sampled = this._sampleLines(lines, Math.max(0, budgetChars - rosterLine.length));
    return `${rosterLine}${sampled}`.slice(0, Math.max(0, budgetChars));
  }

  _participantRoster(segments) {
    const seen = [];
    for (const segment of segments) {
      if (segment.label && !seen.includes(segment.label)) seen.push(segment.label);
    }
    if (seen.length === 0) return "";

    const generic = new Set(
      [
        i18nMain.t("transcript.speaker.you"),
        i18nMain.t("transcript.speaker.others"),
        "You",
        "Others",
        "Unknown Speaker",
      ].filter(Boolean)
    );
    const isPlaceholder = (label) => /^Speaker \d+$/.test(label) || generic.has(label);
    const ordered = [...seen.filter((l) => !isPlaceholder(l)), ...seen.filter(isPlaceholder)];
    const shown = ordered.slice(0, MAX_ROSTER_NAMES);
    const rest = ordered.length - shown.length;
    return rest > 0 ? `${shown.join(", ")}, +${rest} others` : shown.join(", ");
  }

  // Sampling is line-granular, so a plain-text transcript needs at least three
  // lines before it has a middle and an end to sample at all. Blank lines are
  // dropped because an empty line would end a window early.
  _plainTextLines(text) {
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length >= 3) return lines;

    const sentences = (text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [])
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    if (sentences.length >= 3) return sentences;

    const width = Math.max(1, Math.ceil(text.length / 3));
    const windows = [];
    for (let start = 0; start < text.length; start += width) {
      windows.push(text.slice(start, start + width));
    }
    return windows.length > 0 ? windows : lines;
  }

  _sampleLines(lines, budgetChars) {
    const whole = lines.join("\n");
    if (whole.length <= budgetChars) return whole;

    const markers = "[BEGINNING]\n\n\n[MIDDLE]\n\n\n[END]\n".length;
    const share = Math.max(0, Math.floor((budgetChars - markers) / 3));

    // A window claims the lines it used so the next one cannot repeat them.
    // Without this a two-line transcript is sent three times over.
    const claimed = new Set();
    const take = (from, step) => {
      const picked = [];
      let used = 0;
      for (let i = from; i >= 0 && i < lines.length && used < share; i += step) {
        if (claimed.has(i)) break;
        claimed.add(i);
        // Cut inside the line rather than taking it whole: a plain-text
        // transcript with no newlines is ONE line, and letting the first line
        // through unconditionally would spend the entire context on it.
        const line = lines[i].slice(0, share - used);
        if (!line) break;
        picked.push(line);
        used += line.length + 1;
      }
      return step < 0 ? picked.reverse() : picked;
    };

    const beginning = take(0, 1);
    const end = take(lines.length - 1, -1);
    const middle = take(Math.floor(lines.length / 2), 1);

    return (
      `[BEGINNING]\n${beginning.join("\n")}\n\n` +
      `[MIDDLE]\n${middle.join("\n")}\n\n` +
      `[END]\n${end.join("\n")}`
    );
  }

  async _classifyMeetingType(noteId, transcript) {
    // Skip if meeting_type_id is already set (calendar auto-map or user selection)
    const note = this._db.getNote(noteId);
    if (note?.meeting_type_id) {
      debugLogger.info("Pipeline: classify skipped — meeting_type_id already set",
        { noteId, meetingTypeId: note.meeting_type_id }, "meeting");
      return null;
    }

    const types = this._db.getMeetingTypes();
    if (!types || types.length === 0) return null;

    const text = this._flattenTranscript(noteId, transcript);

    // Try LLM classification first
    const config = this._getInferenceConfig();
    if (config) {
      try {
        const typeList = types.map((t) => `- "${t.name}" (id: ${t.id})`).join("\n");
        const classifyPrompt = `You are a meeting classifier. Given the transcript excerpt below, determine which meeting type it best matches from this list:

${typeList}

Reply with ONLY the numeric id of the best matching meeting type. If none match well, reply with "none".`;

        const result = await this._inference.processText(
          this._transcriptDigest(
            noteId,
            transcript,
            await this._digestBudget(config, classifyPrompt)
          ),
          { ...config, systemPrompt: classifyPrompt, temperature: 0 }
        );

        const match = result.trim().match(/^\d+$/);
        const matchedId = match ? parseInt(match[0], 10) : NaN;
        if (!isNaN(matchedId) && types.some((t) => t.id === matchedId)) {
          debugLogger.info("Pipeline: LLM classified meeting type",
            { noteId, meetingTypeId: matchedId }, "meeting");
          return matchedId;
        }
        debugLogger.info("Pipeline: LLM returned no match or invalid id",
          { noteId, raw: result.trim().slice(0, 50) }, "meeting");
      } catch (llmErr) {
        debugLogger.warn("Pipeline: LLM classification failed, falling back to keywords",
          { noteId, error: llmErr.message }, "meeting");
      }
    }

    // Fallback: keyword_rules matching against transcript content
    const lowerText = text.toLowerCase();
    for (const type of types) {
      if (!type.keyword_rules) continue;
      try {
        const keywords = JSON.parse(type.keyword_rules);
        if (Array.isArray(keywords) && keywords.some((kw) => lowerText.includes(kw.toLowerCase()))) {
          debugLogger.info("Pipeline: keyword-matched meeting type",
            { noteId, meetingTypeId: type.id, typeName: type.name }, "meeting");
          return type.id;
        }
      } catch { continue; }
    }

    debugLogger.info("Pipeline: no meeting type matched", { noteId }, "meeting");
    return null;
  }

  async _generateNotes(noteId, transcript) {
    const config = this._getInferenceConfig();
    if (!config) return null;

    const note = this._db.getNote(noteId);
    const meetingType = note?.meeting_type_id
      ? this._db.getMeetingType(note.meeting_type_id)
      : null;
    let systemPrompt = GENERIC_NOTES_PROMPT;
    if (meetingType?.template) systemPrompt = buildTypedNotesPrompt(meetingType);

    const text = this._flattenTranscript(noteId, transcript);

    // `resolveProvider` and not `config.provider`: Settings has been observed
    // persisting a model family ("gemma") into the provider field, and a local
    // model down the single-call path is the failure this method exists to fix.
    const servedLocally =
      MainProcessInference.resolveProvider(config.provider, config.model) === "local";

    if (servedLocally && this._resolveModelContext) {
      const debrief = await this._tryDebrief({
        noteId,
        config,
        transcript,
        meetingTypeTemplate: meetingType?.template || null,
      });
      if (debrief != null) return debrief;
      return this._generateNotesInPasses({ noteId, config, systemPrompt, transcript, text });
    }

    // A cloud model has context to spare, so it takes one call — but it no longer
    // takes only the first 8000 characters, which quietly ended every note at
    // about the 25-minute mark.
    return this._inference.processText(text, { ...config, systemPrompt });
  }

  async _tryDebrief({ noteId, config, transcript, meetingTypeTemplate }) {
    const segments = this._transcriptSegments(noteId, transcript);
    if (segments.length === 0) {
      debugLogger.notice(
        "Pipeline: debrief skipped, the transcript has no speaker segments",
        { noteId },
        "meeting"
      );
      return null;
    }

    const recorderLabel = resolveRecorderLabel(segments);
    if (!recorderLabel) {
      debugLogger.notice(
        "Pipeline: debrief skipped, nobody in the transcript is the recorder",
        { noteId, segments: segments.length },
        "meeting"
      );
      return null;
    }

    if (segments.every((segment) => segment.timestamp === 0)) {
      debugLogger.notice(
        "Pipeline: debrief skipped, the transcript carries no timings to cite",
        { noteId, segments: segments.length },
        "meeting"
      );
      return null;
    }

    const { contextSize } = await this._resolveModelContext(config.model);
    const budgetTokens = Math.floor((contextSize || MIN_CONTEXT) * PROMPT_SHARE);
    const largestPromptTokens = estimatePromptTokens(
      buildSectionPrompt(
        renderDebriefTranscript(segments),
        DEBRIEF_WORST_CASE_ANALYSIS,
        longestDebriefSectionInstruction(meetingTypeTemplate),
        recorderLabel
      )
    );
    if (largestPromptTokens > budgetTokens) {
      debugLogger.notice(
        "Pipeline: debrief skipped, its largest prompt does not fit the context",
        { noteId, largestPromptTokens, budgetTokens, contextSize },
        "meeting"
      );
      return null;
    }

    let reportedSubStage = null;
    try {
      const result = await runMeetingDebrief({
        infer: (prompt, options) => this._inference.processText(prompt, { ...config, ...options }),
        segments,
        meetingTypeTemplate,
        onProgress: ({ phase }) => {
          const subStage = debriefSubStageFor(phase);
          if (subStage === reportedSubStage) return;
          reportedSubStage = subStage;
          this._emitSubStage(noteId, "notes", subStage);
        },
      });

      debugLogger.notice(
        "Pipeline: notes generated as a meeting debrief",
        {
          noteId,
          kind: result.kind,
          calls: result.calls,
          skipped: result.skipped,
          failedProbes: result.failedProbes,
          contextSize,
        },
        "meeting"
      );
      return result.text;
    } catch (err) {
      if (DEBRIEF_PROPAGATED_ERROR_CODES.has(err?.code)) throw err;
      debugLogger.warn(
        "Pipeline: debrief did not apply, falling back to the chunked path",
        { noteId, code: err?.code || null, error: err.message },
        "meeting"
      );
      return null;
    }
  }

  /**
   * Extracts from each chunk of the transcript, then writes the notes once from
   * everything extracted. A meeting longer than the local model's context is the
   * normal case, not an error.
   */
  async _generateNotesInPasses({ noteId, config, systemPrompt, transcript, text }) {
    const { contextSize, isGpuBackend } = await this._resolveModelContext(config.model);
    const segments = this._transcriptSegments(noteId, transcript);

    const result = await runNoteAction({
      systemPrompt,
      segments,
      // Chunking the same text twice would double it into the compose step.
      noteContent: segments.length > 0 ? "" : text,
      contextSize,
      isGpuBackend,
      infer: (prompt, options) =>
        this._inference.processText(prompt, { ...config, ...options }),
    });

    debugLogger.notice(
      "Pipeline: notes generated over multiple passes",
      {
        noteId,
        passes: result.passes,
        partial: result.partial,
        gapCount: result.gapCount,
        contextSize,
      },
      "meeting"
    );

    return result.text;
  }

  /**
   * The transcript as speaker-labelled segments, or an empty array when it is
   * plain text. Segments chunk on speaker turns; plain text can only chunk on
   * sentences.
   */
  _transcriptSegments(noteId, transcript) {
    if (typeof transcript !== "string" || !transcript.startsWith("[")) return [];
    try {
      const parsed = JSON.parse(transcript);
      if (!Array.isArray(parsed)) return [];
      const speakerMappings = buildSpeakerMappings(this._db, noteId);
      return parsed
        .map((s) => ({
          label: resolveSpeaker(s, speakerMappings),
          text: String(s.text ?? ""),
          // The debrief renderer cites [mm:ss] and merges turns on a 30s gap.
          // Without these three fields every line is [00:00] and the whole
          // transcript merges into one turn per speaker.
          timestamp: Number(s.timestamp) || 0,
          speaker: s.speaker,
          source: s.source,
        }))
        .filter((s) => s.text.trim());
    } catch {
      return [];
    }
  }

  _transcriptAsOfNow(noteId, snapshot) {
    try {
      return this._db.getNote(noteId)?.transcript || snapshot;
    } catch {
      return snapshot;
    }
  }

  _getInferenceConfig() {
    const provider = process.env.NOTE_FORMATTING_PROVIDER;
    const model = process.env.NOTE_FORMATTING_MODEL;
    if (!provider || !model) {
      debugLogger.warn("Pipeline: no noteFormatting provider/model configured, skipping AI step", {}, "meeting");
      return null;
    }
    return { provider, model, temperature: 0.3 };
  }

  _flattenTranscript(noteId, transcript) {
    if (typeof transcript !== "string") return String(transcript);
    if (!transcript.startsWith("[")) return transcript;
    try {
      const segments = JSON.parse(transcript);
      const speakerMappings = buildSpeakerMappings(this._db, noteId);
      return segments
        .map((s) => {
          const speaker = resolveSpeaker(s, speakerMappings);
          return speaker ? `${speaker}: ${s.text}` : s.text;
        })
        .join("\n");
    } catch {
      return transcript;
    }
  }

  _emitStatus(noteId, step, status, error = null) {
    const payload = { noteId, step, status };
    if (error) payload.error = error;
    this._broadcast("post-call-pipeline-status", payload);
  }

  _emitSubStage(noteId, step, subStage) {
    this._broadcast("post-call-pipeline-status", {
      noteId, step, status: "running", subStage,
    });
  }

  _broadcastNoteUpdate(noteId) {
    const note = this._db.getNote(noteId);
    if (note) this._broadcast("note-updated", note);
  }
}

module.exports = {
  PostCallPipelineManager,
  GENERIC_NOTES_PROMPT,
  buildTypedNotesPrompt,
  STEP_ORDER,
  isPipelineStep,
  localizedTitlePlaceholders,
  DEBRIEF_PROPAGATED_ERROR_CODES,
};
