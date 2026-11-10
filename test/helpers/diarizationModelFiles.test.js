const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// diarization.js destructures spawn and downloadFile at load time, so both are
// replaced before it is required. Each test file runs in its own process.
const childProcess = require("node:child_process");
const downloadUtils = require("../../src/helpers/downloadUtils.js");

const spawnCalls = [];
childProcess.spawn = (binary, args) => {
  spawnCalls.push({ binary, args });
  const proc = new EventEmitter();
  proc.pid = undefined;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit("close", 0));
  return proc;
};

const downloadedUrls = [];
downloadUtils.downloadFile = async (url, dest) => {
  downloadedUrls.push(url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, "model");
};
downloadUtils.checkDiskSpace = async () => ({ ok: true, availableBytes: Infinity });

const DiarizationManager = require("../../src/helpers/diarization.js");

const RESNET_FILE = "wespeaker_en_voxceleb_resnet293_LM.onnx";
const CAMPP_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

function managerWithModelsIn(dir) {
  const manager = new DiarizationManager();
  manager.getModelsDir = () => dir;
  manager.getBundledModelsDir = () => null;
  manager.getBinaryPath = () => "/fake/sherpa-onnx-diarize";
  return manager;
}

function seedSegmentation(dir) {
  const segDir = path.join(dir, "sherpa-onnx-pyannote-segmentation-3-0");
  fs.mkdirSync(segDir, { recursive: true });
  fs.writeFileSync(path.join(segDir, "model.onnx"), "seg");
}

test("the sherpa diarizer clusters with CAM++ and is never handed the ResNet293 voiceprint model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-args-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, CAMPP_FILE), "campp");
  fs.writeFileSync(path.join(dir, RESNET_FILE), "resnet");
  const wavPath = path.join(dir, "input.wav");
  fs.writeFileSync(wavPath, "wav");

  spawnCalls.length = 0;
  await managerWithModelsIn(dir)._diarizeSherpa(wavPath);

  assert.equal(spawnCalls.length, 1, "sherpa binary was not spawned");
  const { args } = spawnCalls[0];
  assert.ok(
    args.includes(`--embedding.model=${path.join(dir, CAMPP_FILE)}`),
    `embedding arg was ${args.find((a) => a.startsWith("--embedding.model"))}`
  );
  assert.ok(!args.some((a) => a.includes(RESNET_FILE)), "ResNet293 was passed to sherpa");
  assert.ok(args.includes("--clustering.cluster-threshold=0.55"));
});

test("downloading diarization models fetches both the clustering and the voiceprint model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-download-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, "silero_vad.onnx"), "vad");

  downloadedUrls.length = 0;
  const manager = managerWithModelsIn(dir);
  const result = await manager.downloadModels();

  assert.equal(result.success, true);
  assert.ok(
    downloadedUrls.some((u) => u.endsWith(`/${CAMPP_FILE}`)),
    `CAM++ not downloaded: ${downloadedUrls}`
  );
  assert.ok(
    downloadedUrls.some((u) => u.endsWith(`/${RESNET_FILE}`)),
    `ResNet293 not downloaded: ${downloadedUrls}`
  );
  assert.equal(manager.isModelDownloaded(), true);
});

test("downloading skips an embedding model that is already present", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-download-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, "silero_vad.onnx"), "vad");
  fs.writeFileSync(path.join(dir, CAMPP_FILE), "campp");

  downloadedUrls.length = 0;
  await managerWithModelsIn(dir).downloadModels();

  assert.deepEqual(
    downloadedUrls.map((u) => path.basename(u)),
    [RESNET_FILE]
  );
});

async function sherpaArgsFor(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-diar-count-"));
  seedSegmentation(dir);
  fs.writeFileSync(path.join(dir, CAMPP_FILE), "campp");
  fs.writeFileSync(path.join(dir, RESNET_FILE), "resnet");
  const wavPath = path.join(dir, "input.wav");
  fs.writeFileSync(wavPath, "wav");
  const manager = managerWithModelsIn(dir);
  manager.getDiarizationEngine = () => "sherpa";
  spawnCalls.length = 0;
  await manager._diarizeNow(wavPath, options);
  return spawnCalls[0].args;
}

test("a speaker count the user set reaches sherpa as its exact cluster count", async () => {
  const args = await sherpaArgsFor({ maxSpeakers: 3, userSetSpeakers: true });
  assert.ok(args.includes("--clustering.num-clusters=3"), args.join(" "));
});

test("a calendar bound alone never becomes an exact count on sherpa", async () => {
  const args = await sherpaArgsFor({ maxSpeakers: 4 });
  assert.ok(args.includes("--clustering.num-clusters=-1"), args.join(" "));
});
