const fs = require("fs");
const debugLogger = require("./debugLogger");
const speakerEmbeddings = require("./speakerEmbeddings");
const { MAX_EMBEDDING_SECONDS } = speakerEmbeddings;
const { downsample24kTo16k, pcm16ToFloat32 } = require("../utils/audioUtils");
const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");

function clampMaxSpeakers(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_SPEAKER_COUNT;
  return Math.max(1, Math.min(MAX_SPEAKER_COUNT, Math.floor(n)));
}

const SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * MIN_SEGMENT_SECONDS);
const LIVE_IDENTIFICATION_MIN_SECONDS = 1.6;
const LIVE_IDENTIFICATION_MIN_SAMPLES = Math.round(SAMPLE_RATE * LIVE_IDENTIFICATION_MIN_SECONDS);
const LIVE_IDENTIFICATION_INTERVAL_SECONDS = 1.0;
const LIVE_IDENTIFICATION_INTERVAL_SAMPLES = Math.round(
  SAMPLE_RATE * LIVE_IDENTIFICATION_INTERVAL_SECONDS
);
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const SPEECH_CHUNKS_MAX_SAMPLES = MAX_EMBEDDING_SAMPLES * 4;
// Silero's own defaults: 0.5 to open a segment, and neg_threshold = 0.5 - 0.15
// to keep one open. These have to move together with the VAD state fix below —
// they were 0.15/0.08 because a stateless Silero peaks at 0.474 on real audio
// and never once reaches 0.5, so they were percentiles of a crippled signal
// rather than thresholds. Carrying the state without raising them would count
// 13.4% of windows as speech where 9.6% are, which splits more, not less.
const SPEECH_THRESHOLD = 0.5;
const SILENCE_THRESHOLD = 0.35;
const SILENCE_WINDOWS_TO_END = 24;
const {
  MATCH_THRESHOLD,
  acceptsMatch,
} = require("./liveSpeakerMatching");
const LIVE_WINDOW_PADDING_SECONDS = 0.75;
const DEFAULT_VAD_STATE_SHAPE = [2, 1, 64];

function appendFloat32(existing, next) {
  if (!existing.length) return next;
  if (!next.length) return existing;

  const merged = new Float32Array(existing.length + next.length);
  merged.set(existing, 0);
  merged.set(next, existing.length);
  return merged;
}

function concatFloat32Arrays(chunks) {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function trimChunksToMaxSamples(chunks, maxSamples) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  while (total > maxSamples && chunks.length > 0) {
    total -= chunks[0].length;
    chunks.shift();
  }
}

function selectBestEmbeddingWindow(samples) {
  if (samples.length <= MAX_EMBEDDING_SAMPLES) return samples;

  const stride = SAMPLE_RATE;
  let bestStart = 0;
  let bestEnergy = -Infinity;

  for (let start = 0; start + MAX_EMBEDDING_SAMPLES <= samples.length; start += stride) {
    let energy = 0;
    for (let i = start; i < start + MAX_EMBEDDING_SAMPLES; i++) {
      energy += Math.abs(samples[i]);
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }

  return samples.subarray(bestStart, bestStart + MAX_EMBEDDING_SAMPLES);
}

function cloneFloat32Array(value) {
  return new Float32Array(value);
}

function normalizeVadShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) {
    return DEFAULT_VAD_STATE_SHAPE;
  }

  return shape.map((dim) => (typeof dim === "number" && dim > 0 ? dim : 1));
}

function normalizeVadStateName(name) {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function getBufferFloat32View(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

class LiveSpeakerIdentifier {
  constructor() {
    this.session = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    this.audioRemainder = new Float32Array(0);
    this.vadStateInputs = [];
    this.vadStateOutputs = [];
    // Resolved once when the model loads: _updateVadState runs about 31 times a
    // second and the answer cannot change while a session is open.
    this.vadStatePairs = { ok: true, pairs: {}, unpaired: [] };
    this.vadStates = new Map();
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.pendingMerges = [];
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._diarizationManager = null;
    this.maxSpeakers = MAX_SPEAKER_COUNT;
    this.enabled = true;
  }

  setDiarizationManager(manager) {
    this._diarizationManager = manager;
  }

  isAvailable() {
    return this._diarizationManager?.isVadModelDownloaded() && speakerEmbeddings.isAvailable();
  }

  getTransientState() {
    const state = {};

    for (const [speakerId, embedding] of this.transientEmbeddings.entries()) {
      state[speakerId] = {
        embedding: Array.from(embedding),
        displayName: this.transientDisplayNames.get(speakerId) || null,
        profileId: this.transientProfileIds.get(speakerId) ?? null,
        noteId: this.transientNoteIds.get(speakerId) ?? null,
      };
    }

    return state;
  }

  getSpeakerEmbedding(speakerId) {
    const embedding = this.transientEmbeddings.get(speakerId);
    return embedding ? cloneFloat32Array(embedding) : null;
  }

  async start(options = {}, extraOptions = {}) {
    const resolvedOptions =
      typeof options === "function" ? { onSpeakerIdentified: options, ...extraOptions } : options;
    const {
      onSpeakerIdentified = null,
      getSpeakerProfiles = null,
      maxSpeakers = MAX_SPEAKER_COUNT,
      enabled = true,
    } = resolvedOptions;

    this.onSpeakerIdentified =
      typeof onSpeakerIdentified === "function" ? onSpeakerIdentified : null;
    this.getSpeakerProfiles = typeof getSpeakerProfiles === "function" ? getSpeakerProfiles : null;
    this.maxSpeakers = clampMaxSpeakers(maxSpeakers);
    this.enabled = enabled !== false;
    this._resetMeetingState();

    if (!this.isAvailable()) {
      debugLogger.warn("Live speaker identifier unavailable", {
        vadModelPath: this._diarizationManager?.getVadModelPath(),
        embeddingModelAvailable: speakerEmbeddings.isAvailable(),
      });
      return false;
    }

    await this._ensureLoaded();
    this.running = !!this.session;
    return this.running;
  }

  async stop() {
    this.running = false;
    await this.queue;

    if (this.speechActive && this.audioRemainder.length > 0) {
      this.speechChunks.push(this.audioRemainder);
      this.audioRemainder = new Float32Array(0);
    }

    if (this.speechActive) {
      await this._finalizeSpeechSegment();
    }

    const transientState = this.getTransientState();
    this._resetMeetingState();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    return transientState;
  }

  recluster() {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(() => resolve(this._performRecluster()))
        .catch(() => resolve([]));
    });
  }

  _performRecluster() {
    const speakers = [...this.transientEmbeddings.entries()];
    // Still drain: a merge made while assigning may have left fewer than two clusters,
    // and dropping it here would orphan every segment under the removed id.
    if (speakers.length < 2) return this._drainPendingMerges();

    const removed = new Set();

    for (let i = 0; i < speakers.length; i += 1) {
      if (removed.has(speakers[i][0])) continue;
      for (let j = i + 1; j < speakers.length; j += 1) {
        if (removed.has(speakers[j][0])) continue;

        const similarity = speakerEmbeddings.cosineSimilarity(speakers[i][1], speakers[j][1]);
        if (similarity < MATCH_THRESHOLD) continue;

        const countI = this.transientCounts.get(speakers[i][0]) || 1;
        const countJ = this.transientCounts.get(speakers[j][0]) || 1;
        const hasNameI = !!this.transientDisplayNames.get(speakers[i][0]);
        const hasNameJ = !!this.transientDisplayNames.get(speakers[j][0]);
        const keepFirst =
          hasNameI && !hasNameJ ? true : hasNameJ && !hasNameI ? false : countI >= countJ;
        const [keepId, removeId] = keepFirst
          ? [speakers[i][0], speakers[j][0]]
          : [speakers[j][0], speakers[i][0]];
        if (this._hasConflictingIdentity(keepId, removeId)) continue;
        this._mergeTransientSpeakers(keepId, removeId, similarity);
        removed.add(removeId);
      }
    }

    return this._drainPendingMerges();
  }

  // Two clusters that carry different stored profiles, or different user-visible names,
  // are positive evidence of two different people — stronger evidence than any cosine
  // score. Merging them would destroy one person's identity.
  _hasConflictingIdentity(a, b) {
    const profileA = this.transientProfileIds.get(a);
    const profileB = this.transientProfileIds.get(b);
    if (profileA && profileB && profileA !== profileB) return true;

    const nameA = this.transientDisplayNames.get(a);
    const nameB = this.transientDisplayNames.get(b);
    return !!nameA && !!nameB && nameA !== nameB;
  }

  // Every per-speaker map has to move together, or the surviving id ends up half-owning
  // the merged speaker's state.
  _mergeTransientSpeakers(keepId, removeId, similarity) {
    const keepEmb = this.transientEmbeddings.get(keepId);
    const removeEmb = this.transientEmbeddings.get(removeId);
    if (!keepEmb || !removeEmb) return null;

    const keepCount = this.transientCounts.get(keepId) || 1;
    const removeCount = this.transientCounts.get(removeId) || 1;
    const totalCount = keepCount + removeCount;

    const merged = new Float32Array(keepEmb.length);
    for (let k = 0; k < keepEmb.length; k += 1) {
      merged[k] = (keepEmb[k] * keepCount + removeEmb[k] * removeCount) / totalCount;
    }

    this.transientEmbeddings.set(keepId, merged);
    this.transientCounts.set(keepId, totalCount);
    this.transientEmbeddings.delete(removeId);
    this.transientCounts.delete(removeId);

    for (const map of [
      this.transientDisplayNames,
      this.transientProfileIds,
      this.transientNoteIds,
    ]) {
      if (!map.get(keepId) && map.get(removeId)) {
        map.set(keepId, map.get(removeId));
      }
      map.delete(removeId);
    }

    if (this.currentSegmentSpeakerId === removeId) {
      this.currentSegmentSpeakerId = keepId;
      // _performRecluster never did this, so a stale name could still be stamped onto the
      // finished segment.
      this.currentSegmentSpeakerName = this.transientDisplayNames.get(keepId) || null;
    }

    const record = {
      keep: keepId,
      remove: removeId,
      displayName: this.transientDisplayNames.get(keepId) || null,
      similarity,
    };
    this.pendingMerges.push(record);

    debugLogger.info("Speaker merge", {
      keep: keepId,
      remove: removeId,
      similarity: similarity.toFixed(3),
      keepCount,
      removeCount,
    });

    return record;
  }

  // Merges made while assigning a speaker are invisible to the renderer unless they are
  // reported alongside the periodic recluster's own, so every earlier segment under the
  // removed id would orphan.
  _drainPendingMerges() {
    const drained = this.pendingMerges;
    this.pendingMerges = [];
    return drained;
  }

  feedAudio(pcmBuffer) {
    if (!this.running || !pcmBuffer?.length) {
      return Promise.resolve();
    }

    this.queue = this.queue
      .then(() => this._processAudio(pcmBuffer))
      .catch((error) => {
        debugLogger.warn("Live speaker identification failed", { error: error.message });
      });

    return this.queue;
  }

  setMaxSpeakers(n) {
    this.maxSpeakers = clampMaxSpeakers(n);
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
  }

  mapSpeaker(liveId, profileId, displayName, noteId) {
    if (!liveId || !this.transientEmbeddings.has(liveId)) {
      return false;
    }

    if (profileId != null) {
      this.transientProfileIds.set(liveId, profileId);
    }

    if (displayName) {
      this.transientDisplayNames.set(liveId, displayName);
    }

    if (noteId != null) {
      this.transientNoteIds.set(liveId, noteId);
    }

    return true;
  }

  async _ensureLoaded() {
    if (this.session) return;

    const vadModelPath = this._diarizationManager?.getVadModelPath();
    if (!fs.existsSync(vadModelPath)) {
      return;
    }

    const ort = require("onnxruntime-node");
    this.session = await ort.InferenceSession.create(vadModelPath);
    this.vadStateInputs = (this.session.inputNames || []).filter((name) => /state|h|c/i.test(name));
    this.vadStateOutputs = (this.session.outputNames || []).filter((name) =>
      /state|h|c/i.test(name)
    );

    this._resetVadRuntimeState();

    if (!this.vadStatePairs.ok) {
      debugLogger.warn("VAD recurrent state cannot be paired; running stateless", {
        vadModelPath,
        inputs: this.vadStateInputs,
        outputs: this.vadStateOutputs,
        unpaired: this.vadStatePairs.unpaired,
      });
    }
  }


  _resetMeetingState() {
    this.queue = Promise.resolve();
    this.audioRemainder = new Float32Array(0);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.pendingMerges = [];
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._resetVadRuntimeState();
  }

  _resetVadRuntimeState() {
    this.vadStates = new Map();
    // Resolved here rather than in _updateVadState, which runs about 31 times a
    // second: the answer cannot change while the input and output name lists
    // do not, and this is the one place that rebuilds everything derived from
    // them.
    this.vadStatePairs = this.describeVadStatePairing();

    if (!this.session) {
      return;
    }

    for (const name of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[name];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const size = shape.reduce((total, dim) => total * dim, 1);
      this.vadStates.set(name, new Float32Array(size));
    }
  }

  async _processAudio(pcmBuffer) {
    await this._ensureLoaded();
    if (!this.session) return;

    const downsampled = downsample24kTo16k(
      Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer)
    );
    if (!downsampled.length) return;

    this.audioRemainder = appendFloat32(this.audioRemainder, pcm16ToFloat32(downsampled));

    while (this.audioRemainder.length >= VAD_WINDOW_SIZE) {
      const window = this.audioRemainder.subarray(0, VAD_WINDOW_SIZE);
      this.audioRemainder = this.audioRemainder.slice(VAD_WINDOW_SIZE);

      const windowStartSample = this.sampleCursor;
      this.sampleCursor += window.length;

      await this._processWindow(window, windowStartSample, this.sampleCursor);
    }
  }

  async _processWindow(window, windowStartSample, windowEndSample) {
    const probability = await this._getVadProbability(window);

    if (this.speechActive) {
      this.speechChunks.push(cloneFloat32Array(window));
      trimChunksToMaxSamples(this.speechChunks, SPEECH_CHUNKS_MAX_SAMPLES);
      this.segmentEndSample = windowEndSample;

      if (probability >= SILENCE_THRESHOLD) {
        this.silenceWindows = 0;
        await this._identifyActiveSpeechSegment();
        return;
      }

      this.silenceWindows += 1;
      if (this.silenceWindows >= SILENCE_WINDOWS_TO_END) {
        await this._finalizeSpeechSegment();
      }
      return;
    }

    if (probability < SPEECH_THRESHOLD) {
      return;
    }

    this.speechActive = true;
    this.segmentStartSample = windowStartSample;
    this.segmentEndSample = windowEndSample;
    this.speechChunks = [cloneFloat32Array(window)];
    this.silenceWindows = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  async _getVadProbability(window) {
    if (!this.session) return 0;

    const ort = require("onnxruntime-node");
    const feeds = {};
    const audioInputName = (this.session.inputNames || []).find(
      (name) => !this.vadStateInputs.includes(name) && !/sr|sample.?rate/i.test(name)
    );

    if (!audioInputName) {
      return 0;
    }

    feeds[audioInputName] = new ort.Tensor("float32", window, [1, window.length]);

    const sampleRateInputName = (this.session.inputNames || []).find((name) =>
      /sr|sample.?rate/i.test(name)
    );
    if (sampleRateInputName) {
      feeds[sampleRateInputName] = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(SAMPLE_RATE)]),
        [1]
      );
    }

    for (const stateName of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[stateName];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const state =
        this.vadStates.get(stateName) || new Float32Array(shape.reduce((a, b) => a * b, 1));

      this.vadStates.set(stateName, state);
      feeds[stateName] = new ort.Tensor("float32", state, shape);
    }

    const results = await this.session.run(feeds);
    this._updateVadState(results);

    const outputName = (this.session.outputNames || []).find(
      (name) => !this.vadStateOutputs.includes(name)
    );
    const output = (outputName && results[outputName]) || Object.values(results)[0];
    const value = output?.data?.[0];
    return typeof value === "number" ? value : 0;
  }

  /**
   * Which output tensor carries each state input's next value.
   *
   * Silero names them three different ways across its exports — `h`/`c` become
   * `hn`/`cn` in v4 and `new_h`/`new_c` in v5, and the unified export turns
   * `state` into `stateN` — so both a prefix and a suffix match are legitimate.
   * The prefix-only rule that shipped missed v5, which is the model bundled
   * here, and missed it in silence.
   *
   * Matching is by name only. Pairing by position instead would look tempting
   * — ONNX Runtime reports names in the model's declared order — but the lists
   * come from a substring filter, so an output merely containing an "h" or a
   * "c", or outputs declared in a different order from the inputs, would pair a
   * state input with someone else's tensor and say nothing. That is the same
   * silent corruption this method exists to fix. An input that pairs with
   * nothing is reported, not guessed at.
   */
  describeVadStatePairing() {
    const pairs = {};
    const unpaired = [];

    for (const inputName of this.vadStateInputs) {
      const expected = normalizeVadStateName(inputName);
      const output = this.vadStateOutputs.find((outputName) => {
        const actual = normalizeVadStateName(outputName);
        return actual.startsWith(expected) || actual.endsWith(expected);
      });

      if (output) {
        pairs[inputName] = output;
      } else {
        unpaired.push(inputName);
      }
    }

    return { ok: unpaired.length === 0, pairs, unpaired };
  }

  _updateVadState(results) {
    if (!results) {
      return;
    }

    const { pairs } = this.vadStatePairs;

    for (const inputName of this.vadStateInputs) {
      const output = results[pairs[inputName]] ?? results[inputName];

      if (output?.data) {
        this.vadStates.set(inputName, new Float32Array(output.data));
      }
    }
  }

  async _identifyActiveSpeechSegment(force = false) {
    const allSamples = concatFloat32Arrays(this.speechChunks);
    if (allSamples.length < LIVE_IDENTIFICATION_MIN_SAMPLES) {
      return;
    }
    const currentSamples =
      allSamples.length > MAX_EMBEDDING_SAMPLES
        ? allSamples.subarray(allSamples.length - MAX_EMBEDDING_SAMPLES)
        : allSamples;

    if (
      !force &&
      this.lastLiveIdentificationSample > 0 &&
      this.segmentEndSample - this.lastLiveIdentificationSample <
        LIVE_IDENTIFICATION_INTERVAL_SAMPLES
    ) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(currentSamples);
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: false });
    if (!resolved?.speakerId) {
      return;
    }

    this.currentSegmentSpeakerId = resolved.speakerId;
    this.currentSegmentSpeakerName = resolved.displayName || null;
    this.lastLiveIdentificationSample = this.segmentEndSample;

    if (!this.enabled) return;

    this.onSpeakerIdentified?.({
      speakerId: resolved.speakerId,
      displayName: resolved.displayName || null,
      startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
      endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
    });
  }

  async _finalizeSpeechSegment() {
    const samples = concatFloat32Arrays(this.speechChunks);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;

    if (samples.length < MIN_SEGMENT_SAMPLES) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(
      selectBestEmbeddingWindow(samples)
    );
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: true });
    if (!resolved?.speakerId) {
      return;
    }

    const speakerId = resolved.speakerId;
    const displayName =
      resolved.displayName ||
      this.currentSegmentSpeakerName ||
      this.transientDisplayNames.get(speakerId) ||
      null;

    if (this.enabled) {
      this.onSpeakerIdentified?.({
        speakerId,
        displayName,
        startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
        endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
      });
    }

    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  _findTransientMatch(embedding) {
    let bestSpeakerId = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return acceptsMatch(bestSimilarity, secondBestSimilarity) ? bestSpeakerId : null;
  }

  _findStoredProfileMatch(embedding) {
    let profiles = [];

    try {
      profiles = this.getSpeakerProfiles?.() || [];
    } catch (error) {
      debugLogger.debug("Live speaker profile lookup failed", { error: error.message });
      return null;
    }

    let bestProfile = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const profile of profiles) {
      if (!profile?.embedding) continue;

      const profileEmbedding =
        profile.embedding instanceof Float32Array
          ? profile.embedding
          : Array.isArray(profile.embedding)
            ? new Float32Array(profile.embedding)
            : getBufferFloat32View(profile.embedding);

      if (!profileEmbedding.length) continue;

      const similarity = speakerEmbeddings.cosineSimilarity(embedding, profileEmbedding);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestProfile = profile;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return acceptsMatch(bestSimilarity, secondBestSimilarity) ? bestProfile : null;
  }

  _resolveSpeakerForEmbedding(embedding, options = {}) {
    const { updateCentroid = false } = options;

    let speakerId = this.currentSegmentSpeakerId || this._findTransientMatch(embedding);
    let displayName = this.currentSegmentSpeakerName || null;

    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      return {
        speakerId,
        displayName: displayName || this.transientDisplayNames.get(speakerId) || null,
      };
    }

    const matchedProfile = this._findStoredProfileMatch(embedding);
    if (matchedProfile) {
      speakerId = this._findTransientSpeakerForProfile(matchedProfile.id);
      if (!speakerId) {
        speakerId = this._assignOrForceCluster(embedding, { profileId: matchedProfile.id });
      } else if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      this.transientProfileIds.set(speakerId, matchedProfile.id);
      this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
      return {
        speakerId,
        displayName: matchedProfile.display_name,
      };
    }

    speakerId = this.currentSegmentSpeakerId || this._assignOrForceCluster(embedding);
    if (updateCentroid && this.currentSegmentSpeakerId) {
      this._updateCentroid(speakerId, embedding);
    }

    return {
      speakerId,
      displayName: this.transientDisplayNames.get(speakerId) || null,
    };
  }

  // (best, second) alone cannot tell "two similar people" from "one person's duplicates".
  // The discriminating signal is how similar the two candidate CLUSTERS are to each
  // other — the same test _performRecluster already applies every 30 seconds. So a
  // confirmed duplicate pair is merged outright (which stops it re-triggering on every
  // later utterance), and otherwise the voice joins its best match rather than minting
  // yet another cluster. Minting while a real candidate exists is what produced
  // speaker_23/27/28 on a three-person call.
  _assignOrForceCluster(embedding, options = {}) {
    const { profileId = null } = options;
    const { bestId, bestSimilarity, secondId, secondSimilarity } =
      this._findTopTransients(embedding);

    if (!bestId || bestSimilarity < MATCH_THRESHOLD) {
      return this._assignSpeakerId(embedding);
    }

    // A stored profile is stronger evidence of a distinct person than a cosine score, so
    // it may not take over a cluster that already belongs to someone else. This is the
    // one case where minting above the threshold is correct.
    if (profileId && this._identityConflictsWith(bestId, profileId)) {
      return this._assignSpeakerId(embedding);
    }

    if (acceptsMatch(bestSimilarity, secondSimilarity)) {
      this._updateCentroid(bestId, embedding);
      return bestId;
    }

    if (secondId && !this._hasConflictingIdentity(bestId, secondId)) {
      const clusterSimilarity = speakerEmbeddings.cosineSimilarity(
        this.transientEmbeddings.get(bestId),
        this.transientEmbeddings.get(secondId)
      );
      if (clusterSimilarity >= MATCH_THRESHOLD) {
        const keepFirst = this._preferredSurvivor(bestId, secondId);
        const [keepId, removeId] = keepFirst ? [bestId, secondId] : [secondId, bestId];
        this._mergeTransientSpeakers(keepId, removeId, clusterSimilarity);
        this._updateCentroid(keepId, embedding);
        return keepId;
      }
    }

    // Genuinely ambiguous: assign to the best match, but deliberately do NOT move its
    // centroid — otherwise an absorbed stranger drags the cluster toward itself and
    // every later utterance matches harder.
    return bestId;
  }

  _identityConflictsWith(speakerId, profileId) {
    const existing = this.transientProfileIds.get(speakerId);
    return !!existing && existing !== profileId;
  }

  _preferredSurvivor(a, b) {
    const hasNameA = !!this.transientDisplayNames.get(a);
    const hasNameB = !!this.transientDisplayNames.get(b);
    if (hasNameA !== hasNameB) return hasNameA;
    return (this.transientCounts.get(a) || 1) >= (this.transientCounts.get(b) || 1);
  }

  _findTopTransients(embedding) {
    let bestId = null;
    let bestSimilarity = -Infinity;
    let secondId = null;
    let secondSimilarity = -Infinity;

    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondId = bestId;
        secondSimilarity = bestSimilarity;
        bestId = speakerId;
        bestSimilarity = similarity;
      } else if (similarity > secondSimilarity) {
        secondId = speakerId;
        secondSimilarity = similarity;
      }
    }

    return { bestId, bestSimilarity, secondId, secondSimilarity };
  }

  _findTransientSpeakerForProfile(profileId) {
    for (const [speakerId, candidateProfileId] of this.transientProfileIds.entries()) {
      if (candidateProfileId === profileId) {
        return speakerId;
      }
    }

    return null;
  }

  _assignSpeakerId(embedding) {
    const speakerId = `speaker_${this.nextLiveIndex}`;
    this.nextLiveIndex += 1;
    this.transientEmbeddings.set(speakerId, cloneFloat32Array(embedding));
    this.transientCounts.set(speakerId, 1);
    return speakerId;
  }

  _updateCentroid(speakerId, embedding) {
    const centroid = this.transientEmbeddings.get(speakerId);
    if (!centroid) {
      return;
    }

    const count = this.transientCounts.get(speakerId) || 1;
    const nextCentroid = new Float32Array(embedding.length);

    for (let i = 0; i < embedding.length; i += 1) {
      nextCentroid[i] = (centroid[i] * count + embedding[i]) / (count + 1);
    }

    this.transientEmbeddings.set(speakerId, nextCentroid);
    this.transientCounts.set(speakerId, count + 1);
  }
}

const instance = new LiveSpeakerIdentifier();
module.exports = instance;
module.exports.LiveSpeakerIdentifier = LiveSpeakerIdentifier;
