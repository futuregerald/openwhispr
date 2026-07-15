const GpuBinaryManager = require("./gpuBinaryManager");

// Pinned so untested future binaries never auto-ship; bump deliberately along
// with the digests below. Overridable via WHISPER_CPP_VERSION for testing.
const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.8";

// sha256 per release tag, taken from the GitHub release asset digests. For
// tags without an entry the API-reported digest is used instead.
const EXPECTED_DIGESTS = {
  "0.0.8": {
    "whisper-server-win32-x64-vulkan.zip":
      "d5f6188bb6561e66a9b7886ca0448d5927cb9713a02d311b87a20e33eb038222",
    "whisper-server-linux-x64-vulkan.zip":
      "6e3e355dff3a1e96550d63445dc1ba4a881c2e63fe93be6a4f5ed946a204be27",
  },
};

// Vulkan whisper-server for AMD/Intel GPUs on Windows/Linux. Statically
// linked — no companion libs, so it never clobbers DLLs in userData/bin.
class WhisperVulkanManager extends GpuBinaryManager {
  constructor() {
    super({
      name: "Vulkan whisper",
      releaseUrl: `https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/tags/${WHISPER_CPP_TAG}`,
      expectedDigests: EXPECTED_DIGESTS[WHISPER_CPP_TAG],
      assets: {
        "win32-x64": {
          assetName: "whisper-server-win32-x64-vulkan.zip",
          binaryName: "whisper-server-win32-x64-vulkan.exe",
          outputName: "whisper-server-win32-x64-vulkan.exe",
        },
        "linux-x64": {
          assetName: "whisper-server-linux-x64-vulkan.zip",
          binaryName: "whisper-server-linux-x64-vulkan",
          outputName: "whisper-server-linux-x64-vulkan",
        },
      },
    });
  }
}

module.exports = WhisperVulkanManager;
