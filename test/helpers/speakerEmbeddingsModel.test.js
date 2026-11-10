const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const speakerEmbeddings = require("../../src/helpers/speakerEmbeddings.js");
const onnxWorkerClient = require("../../src/helpers/onnxWorkerClient.js");
const DiarizationManager = require("../../src/helpers/diarization.js");

const { SpeakerEmbeddings, MODEL_ID, MODEL_FILE, l2Normalize } = speakerEmbeddings;

const RESNET_FILE = "wespeaker_en_voxceleb_resnet293_LM.onnx";
const CAMPP_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

const norm = (v) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));

function seededVector(dim, seed) {
  let state = seed;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out[i] = state / 2147483648 - 0.5;
  }
  return out;
}

test("the voiceprint model is WeSpeaker ResNet293-LM, identified by a stable model id", () => {
  assert.equal(MODEL_FILE, RESNET_FILE);
  assert.equal(MODEL_ID, "wespeaker-resnet293-lm");
});

test("a centroid of 256-d embeddings is 256-d, finite and unit length", () => {
  const inputs = [seededVector(256, 1), seededVector(256, 2), seededVector(256, 3)];
  const centroid = speakerEmbeddings.computeCentroid(inputs);
  assert.equal(centroid.length, 256);
  assert.ok(Array.from(centroid).every(Number.isFinite), "centroid has non-finite values");
  assert.ok(Math.abs(norm(centroid) - 1) < 1e-5, `norm was ${norm(centroid)}`);
});

test("a centroid weighs each embedding equally regardless of its raw magnitude", () => {
  const loud = Float32Array.from([100, 0]);
  const quiet = Float32Array.from([0, 1]);
  const centroid = speakerEmbeddings.computeCentroid([loud, quiet]);
  assert.ok(Math.abs(centroid[0] - centroid[1]) < 1e-6, `got ${Array.from(centroid)}`);
});

test("a centroid of nothing is empty rather than a fixed-size zero vector", () => {
  assert.equal(speakerEmbeddings.computeCentroid([]).length, 0);
});

test("l2Normalize returns a unit-length copy and leaves a zero vector at zero", () => {
  const input = Float32Array.from([3, 4]);
  const out = l2Normalize(input);
  assert.deepEqual(Array.from(out), [0.6000000238418579, 0.800000011920929]);
  assert.deepEqual(Array.from(input), [3, 4], "input was mutated");
  assert.deepEqual(Array.from(l2Normalize(new Float32Array(3))), [0, 0, 0]);
  assert.deepEqual(Array.from(l2Normalize([0, 2])), [0, 1]);
});

test("cosine similarity refuses to compare embeddings of different dimensions", () => {
  assert.throws(
    () => speakerEmbeddings.cosineSimilarity(seededVector(256, 1), seededVector(512, 1)),
    RangeError
  );
  assert.throws(
    () => speakerEmbeddings.cosineSimilarity(seededVector(512, 1), seededVector(256, 1)),
    RangeError
  );
});

test("cosine similarity of equal-length embeddings still works", () => {
  const a = seededVector(256, 4);
  assert.ok(Math.abs(speakerEmbeddings.cosineSimilarity(a, a) - 1) < 1e-6);
});

test("an extracted embedding is returned L2-normalised", async (t) => {
  const extractor = new SpeakerEmbeddings();
  extractor._ensureLoaded = async () => {};
  const raw = Float32Array.from([3, 0, 4, 0]);
  const original = onnxWorkerClient.request;
  onnxWorkerClient.request = async (type) => {
    assert.equal(type, "speaker.extract");
    return { embeddingBuffer: raw.buffer.slice(0) };
  };
  t.after(() => {
    onnxWorkerClient.request = original;
  });

  const embedding = await extractor.extractEmbeddingFromSamples(new Float32Array(16000 * 2));
  assert.equal(embedding.length, 4);
  assert.ok(Math.abs(norm(embedding) - 1) < 1e-6, `norm was ${norm(embedding)}`);
  assert.ok(Math.abs(embedding[0] - 0.6) < 1e-6);
});

function managerWithModelsIn(dir) {
  const manager = new DiarizationManager();
  manager.getModelsDir = () => dir;
  manager.getBundledModelsDir = () => null;
  return manager;
}

function seedSegmentation(dir) {
  const segDir = path.join(dir, "sherpa-onnx-pyannote-segmentation-3-0");
  fs.mkdirSync(segDir, { recursive: true });
  fs.writeFileSync(path.join(segDir, "model.onnx"), "seg");
}

test("diarization models do not count as downloaded when only the old CAM++ file is present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-models-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, CAMPP_FILE), "campp");
  assert.equal(managerWithModelsIn(dir).isModelDownloaded(), false);

  fs.writeFileSync(path.join(dir, RESNET_FILE), "resnet");
  assert.equal(managerWithModelsIn(dir).isModelDownloaded(), true);
});

test("deleting diarization models also removes a leftover CAM++ file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-models-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, CAMPP_FILE), "campp");
  fs.writeFileSync(path.join(dir, RESNET_FILE), "resnet");
  await managerWithModelsIn(dir).deleteModels();
  assert.equal(fs.existsSync(path.join(dir, CAMPP_FILE)), false, "CAM++ left behind");
  assert.equal(fs.existsSync(path.join(dir, RESNET_FILE)), false, "ResNet293 left behind");
});

test("the speaker extractor and the diarizer agree on the embedding model file", () => {
  assert.equal(DiarizationManager.EMBEDDING_ONNX, MODEL_FILE);
});

test("the disk-space precheck covers the ResNet293 download", () => {
  assert.ok(
    DiarizationManager.MODEL_DOWNLOAD_BYTES >= 114_336_527 + 6_600_000,
    `precheck was ${DiarizationManager.MODEL_DOWNLOAD_BYTES}`
  );
});

test("a centroid refuses embeddings of mixed dimensions instead of padding with NaN", () => {
  assert.throws(
    () => speakerEmbeddings.computeCentroid([seededVector(256, 1), seededVector(512, 2)]),
    RangeError
  );
});
