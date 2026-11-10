const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const onnxWorkerClient = require("./onnxWorkerClient");

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE * MIN_SEGMENT_SECONDS;
const MAX_EMBEDDING_SECONDS = 8;
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const MODEL_FILE = "wespeaker_en_voxceleb_resnet293_LM.onnx";
const MODEL_ID = "wespeaker-resnet293-lm";

function l2Normalize(vec) {
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i++) sumSquares += vec[i] * vec[i];
  const out = new Float32Array(vec.length);
  if (sumSquares === 0) return out;
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

class SpeakerEmbeddings {
  constructor() {
    this.loadPromise = null;
  }

  getModelPath() {
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "bin", "diarization-models", MODEL_FILE);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), MODEL_FILE);
  }

  isAvailable() {
    return fs.existsSync(this.getModelPath());
  }

  _ensureLoaded() {
    if (this.loadPromise) return this.loadPromise;
    if (!this.isAvailable()) {
      return Promise.reject(
        new Error(`Speaker embedding model not found at ${this.getModelPath()}`)
      );
    }
    const modelPath = this.getModelPath();
    debugLogger.debug("speaker-embeddings loading model", { modelPath });
    this.loadPromise = onnxWorkerClient
      .request("speaker.load", { modelPath })
      .then(() => debugLogger.debug("speaker-embeddings model loaded"))
      .catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    return this.loadPromise;
  }

  async _extractEmbeddingFromSamples(samples) {
    await this._ensureLoaded();

    const samplesBuffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );

    // No transfer-list: MessagePortMain can't transfer ArrayBuffers, so the samples are cloned.
    const { embeddingBuffer } = await onnxWorkerClient.request("speaker.extract", {
      samplesBuffer,
    });

    if (!embeddingBuffer) return null;
    return l2Normalize(new Float32Array(embeddingBuffer));
  }

  async extractEmbeddingFromSamples(samples) {
    if (samples.length < MIN_SEGMENT_SAMPLES) return null;
    const capped =
      samples.length > MAX_EMBEDDING_SAMPLES
        ? samples.subarray(samples.length - MAX_EMBEDDING_SAMPLES)
        : samples;
    return this._extractEmbeddingFromSamples(capped);
  }

  async extractEmbedding(wavPath, startSec, endSec) {
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;

    const buf = fs.readFileSync(wavPath);
    const { sampleRate, dataOffset } = this._parseWavHeader(buf);

    const cappedSeconds = Math.min(endSec - startSec, MAX_EMBEDDING_SECONDS);
    const cappedStartSec = endSec - cappedSeconds;
    const startSample = Math.floor(cappedStartSec * sampleRate);
    const endSample = Math.floor(endSec * sampleRate);
    const numSamples = endSample - startSample;

    const samples = new Float32Array(numSamples);
    const bytesPerSample = 2;
    const offset = dataOffset + startSample * bytesPerSample;

    for (let i = 0; i < numSamples; i++) {
      const bytePos = offset + i * bytesPerSample;
      if (bytePos + 1 >= buf.length) break;
      const int16 = buf.readInt16LE(bytePos);
      samples[i] = int16 / 32768;
    }

    return this._extractEmbeddingFromSamples(samples);
  }

  _parseWavHeader(buf) {
    let offset = 12;
    let sampleRate = 16000;
    let dataOffset = 44;

    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        sampleRate = buf.readUInt32LE(offset + 12);
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    return { sampleRate, dataOffset };
  }

  computeCentroid(embeddings) {
    if (embeddings.length === 0) return new Float32Array(0);

    const dim = embeddings[0].length;
    const sum = new Float32Array(dim);
    for (const emb of embeddings) {
      if (emb.length !== dim) {
        throw new RangeError(`Embedding dimension mismatch: ${emb.length} vs ${dim}`);
      }
      const unit = l2Normalize(emb);
      for (let i = 0; i < dim; i++) {
        sum[i] += unit[i];
      }
    }
    return l2Normalize(sum);
  }

  cosineSimilarity(a, b) {
    if (a.length !== b.length) {
      throw new RangeError(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

const instance = new SpeakerEmbeddings();
module.exports = instance;
module.exports.SpeakerEmbeddings = SpeakerEmbeddings;
module.exports.MAX_EMBEDDING_SECONDS = MAX_EMBEDDING_SECONDS;
module.exports.MODEL_FILE = MODEL_FILE;
module.exports.MODEL_ID = MODEL_ID;
module.exports.l2Normalize = l2Normalize;
