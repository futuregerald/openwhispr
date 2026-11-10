# Kaldi fbank parity fixtures

Reference 80-bin log-mel filterbank features from `torchaudio.compliance.kaldi.fbank`, called exactly as
WeSpeaker's `infer_onnx.py` calls it (`window_type="hamming"`, `dither=0.0`, `use_energy=False`, waveform at int16
scale), before and after per-utterance mean subtraction. `test/helpers/kaldiFbank.test.js` checks
`src/helpers/kaldiFbank.js` against them.

The signals are synthetic (a sweep, seeded noise, half silence then a tone). No recorded audio.

Regenerate with torch 2.8.0 and torchaudio 2.8.0:

```
uv venv --python 3.12 /tmp/fbank-venv
VIRTUAL_ENV=/tmp/fbank-venv uv pip install torch==2.8.0 torchaudio==2.8.0 numpy
/tmp/fbank-venv/bin/python -I scripts/generate-kaldi-fbank-fixtures.py test/fixtures/kaldi-fbank
```

`flooredFrames` marks frames where torchaudio clamped a value to the float32 epsilon floor. Those frames are
compared loosely, because a float64 FFT lands at a different point under the floor.
