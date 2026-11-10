import json, math, sys, os
import numpy as np, torch, torchaudio
import torchaudio.compliance.kaldi as kaldi
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
sr = 16000
n = 8000
t = np.arange(n) / sr
rng = np.random.default_rng(1234)
signals = {
  "sweep": 0.5 * np.sin(2 * np.pi * (100 + (3900 * t / t[-1]) / 2) * t),
  "noise": np.clip(rng.normal(0, 0.2, n), -1, 1),
  "silence_then_tone": np.concatenate([np.zeros(n // 2), 0.3 * np.sin(2 * np.pi * 440 * t[: n - n // 2])]),
}
eps = float(torch.finfo(torch.float).eps)
for name, x in signals.items():
  pcm = np.round(x * 32767).astype(np.int16)
  wav = torch.from_numpy(pcm.astype(np.float32)).unsqueeze(0)
  fb = kaldi.fbank(wav, num_mel_bins=80, frame_length=25, frame_shift=10, dither=0.0,
                   sample_frequency=sr, window_type="hamming", use_energy=False)
  cmn = fb - fb.mean(dim=0)
  floored = (fb <= math.log(eps) + 1e-6).any(dim=1).tolist()
  json.dump({"sampleRate": sr, "pcm16": pcm.tolist(), "numFrames": fb.shape[0], "numMels": 80,
             "fbank": [round(v, 6) for v in fb.flatten().tolist()],
             "cmn": [round(v, 6) for v in cmn.flatten().tolist()],
             "flooredFrames": floored},
            open(os.path.join(out, f"{name}.json"), "w"))
  print(name, fb.shape, "floored frames:", sum(floored))
print("torch", torch.__version__, "torchaudio", torchaudio.__version__)
