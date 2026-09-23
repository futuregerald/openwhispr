const { formatTimestamp, resolveSpeaker } = require("./transcriptFormatter");
const { segmentRowsForNote, readSpeakerMappings } = require("./transcriptSegmentIndex");

const DEFAULT_MAX_CHARS = 20000;

function labelForRow(row, speakerMappings) {
  if (row.speaker_name) return row.speaker_name;
  return resolveSpeaker({ speaker: row.speaker_id }, speakerMappings);
}

function renderSegments(rows, speakerMappings) {
  const runs = [];
  for (const row of rows) {
    if (!row.text?.trim()) continue;
    const speaker = labelForRow(row, speakerMappings);
    const offsetMs = row.offset_ms;
    const previous = runs[runs.length - 1];
    const mergeable =
      previous &&
      previous.speaker === speaker &&
      previous.offsetMs != null &&
      offsetMs != null &&
      offsetMs - previous.offsetMs >= 0 &&
      offsetMs - previous.offsetMs < 2000;

    if (mergeable) {
      previous.text = `${previous.text} ${row.text.trim()}`;
      previous.offsetMs = offsetMs;
    } else {
      runs.push({ speaker, text: row.text.trim(), offsetMs, startOffsetMs: offsetMs });
    }
  }

  const lines = [];
  for (const run of runs) {
    const stamp =
      run.startOffsetMs != null ? ` \`${formatTimestamp(run.startOffsetMs / 1000)}\`` : "";
    lines.push(`**${run.speaker}**${stamp}`);
    lines.push(run.text, "");
  }

  return { text: lines.join("\n").trim(), segmentCount: runs.length };
}

function resolveNoteBody(db, note, options = {}) {
  const { maxChars = DEFAULT_MAX_CHARS } = options;

  const rows = note?.id != null ? segmentRowsForNote(db, note.id) : [];
  const speakerMappings = note?.id != null ? readSpeakerMappings(db, note.id) : {};

  const hasUnmappedSpeakers = rows.some((row) => !row.speaker_name && row.speaker_id);

  let body = "";
  let kind = "empty";

  const enhanced = (note?.enhanced_content ?? "").trim();
  const plain = (note?.content ?? "").trim();

  if (enhanced) {
    body = enhanced;
    kind = "enhanced";
  } else if (plain) {
    body = plain;
    kind = "plain";
  } else if (rows.length > 0) {
    const rendered = renderSegments(rows, speakerMappings);
    if (rendered.segmentCount > 0 && rendered.text) {
      body = rendered.text;
      kind = "transcript";
    }
  }

  const bodyChars = body.length;
  const truncated = bodyChars > maxChars;

  return {
    body: truncated ? body.slice(0, maxChars) : body,
    body_kind: kind,
    body_chars: bodyChars,
    truncated,
    has_unmapped_speakers: hasUnmappedSpeakers,
  };
}

module.exports = { resolveNoteBody, renderSegments };
