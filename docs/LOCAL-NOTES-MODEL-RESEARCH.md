# Local meeting-notes model research

**Question:** how close can locally-generated meeting notes get to a strong cloud model's
debrief, on a 24 GB M4 Pro that is already under memory pressure, running one model at a time?

**Answer:** close. **Gemma 4 E4B QAT q4_0 driven as ~19 short cached calls instead of one long
one** scored 9–11 of 11 reference checks, against 5–6 for the single-call prompt the app shipped
before. It costs about 110 s and ~700 MB of working memory on top of the 4.8 GB model.

Companion docs: [`LOCAL-DIARIZATION-RESEARCH.md`](LOCAL-DIARIZATION-RESEARCH.md) ·
[`DECISIONS-LOG.md`](DECISIONS-LOG.md)

---

## How it was measured

A reference debrief of one real 35-minute interview was written by a frontier cloud model, and 11
specific checks were derived from it: **six things** a good debrief of that conversation must
contain (a question the interviewer announced but never asked; an outcome a candidate never
quantified; an escalation path that was named; an exact quote; a commitment to follow up; the
reason the meeting was happening at all) and **five it must not** contain (a misquote, two
distinct misattributions, the recorder's own words credited to the other person, a
wrongly-formatted timestamp). Each candidate configuration was scored against all 11.

The scorer and every generated debrief are **deliberately not in this repository**: they embed a
real conversation with real people in it. They live in an untracked worktree
(`experiments/notes-model/`, with `results/` in `.git/info/exclude`). What is committed is the
prompt set, in `test/fixtures/debrief-prompts-en/`, and a test asserting the code builds those
exact bytes — so the numbers below stay attached to the code that ships.

The 11-check scorer is specific to that one conversation. It says whether a configuration finds
what is there to be found; it is not a general quality metric, and it is meaningless run against
any other note.

## Results

| Configuration                                                | Score                    | Wall time     | Peak working memory |
| ------------------------------------------------------------ | ------------------------ | ------------- | ------------------- |
| Single call, the app's previous prompt, Gemma 4 E4B Q4_K_M   | 5/11                     | 34.8 s        | 637 MB              |
| Single call, the app's previous prompt, Gemma 4 E4B QAT q4_0 | 6/11                     | 30.0 s        | 638 MB              |
| Single call, a much better prompt, Gemma 4 12B QAT           | 8/11                     | 105.7 s       | 1,283 MB            |
| **19 cached calls ("probes"), Gemma 4 E4B QAT q4_0**         | **9–11/11** over 11 runs | **100–149 s** | **639–714 MB**      |
| Reference (cloud frontier model)                             | 11/11                    | —             | —                   |

Eleven runs of the probes shape on that transcript scored 9, 9, 10, 11, 10, 10, 10, 10, 11, 9 and
11 — never below 9, and never worse than the 12B model on one call. **The four runs of the exact
prompt set that shipped** (`probes-app`, which differs from the experiment's only in carrying no
personal name) scored **10, 11, 9 and 11**, at 108.7–148.8 s and 671–714 MB. The 11/11 run is the
one taken with the llama-server flags this release actually uses.

**The single largest quality jump came from the pipeline shape, not the model.** A 12B model on
one call scored 8; a 4B model asked nineteen focused questions scored 9–11, in the same wall time
and at half the memory.

## Why nineteen calls are affordable

The transcript is sent once. Every prompt after the first begins with a byte-identical transcript
block, so llama.cpp's prompt cache serves it: the first call prefills 7,481 tokens in 11.0 s, and
the remaining 18 calls report 7,437–9,404 tokens already cached and cost 1.5–14.4 s each.

**This is fragile in one specific way: if any template's leading bytes drift, the cache misses and
that call re-processes the whole transcript.** During the experiment a one-character header
difference cost about 30 s per call. `test/helpers/meetingDebriefPrompts.test.js` asserts the
shared prefix is byte-identical across every probe and every section for exactly this reason —
nothing else in the app can see that invariant.

## What the pipeline does

1. **`kind`** — one word: interview, evaluation, one-on-one, team, planning, customer, vendor,
   other. This call pays the transcript prefill that any first call must pay; its two-token answer
   decides whether an Assessment section is written.
2. **Nine focused probes**, one question per call: why this meeting is happening now; questions
   announced but never asked; whether each story stated a business outcome; how disagreements were
   settled; what the recorder said that was candid or inconsistent; how the other person
   communicated; every commitment made; what was missing and what could go wrong; an overview with
   the most generous and most cynical reading. A tenth verdict probe runs only for interviews and
   evaluations.
3. **One call per section** — TL;DR, Meeting Context, Topics, Assessment, Dynamics & Subtext,
   Commitments, Gaps & Risks, Recommendations — each given the transcript and the probe answers.

Asking one question at a time is what makes a 4B model competitive. Every attempt to batch the
analysis lost findings: a single large write step after the analysis "dropped findings the
analysis had caught", and a three-stage extract → analyse → write pipeline lost the transcript by
the write stage and started misattributing pronouns.

## What did not work

| Attempt                                 | Outcome                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Gemma 4 12B QAT                         | Better single-pass notes, but ~2× slower, system free memory dipped to 10%, and the machine was noticeably slower to use |
| MTP speculative decoding on 12B         | **Slower** on Metal: 11.7 tok/s at n-max 4 and 19.4 at n-max 2, against 21.8 with no drafting                            |
| Qwen 3.5 9B                             | Mixed people up — attributed one participant's leave of absence to another. Thinking mode took 4 minutes                 |
| Gemma thinking mode on E4B              | Confused the recorder with the other person                                                                              |
| Three-pass extract → analyse → write    | The write step lost the transcript and misattributed pronouns                                                            |
| One large write step after the analysis | Dropped findings the analysis had already caught                                                                         |

## llama-server flags

The experiment ran with `--parallel 1 --cache-ram 0 --ctx-checkpoints 8 -fa on -ctk q8_0
-ctv q8_0`. **Only the last three shipped**, and the reasons the other three did not are worth
recording, because they are the opposite of what the experiment concluded:

- **`-fa on -ctk q8_0 -ctv q8_0` (adopted, macOS only).** Halves KV-cache bytes per token, so more
  of the cached prefix fits. Measured starting cleanly on the bundled build 9763 arm64 binary, with
  no reduction in the context the server reports. `-ctv` quantisation requires flash attention,
  which is why `-fa` is set explicitly rather than left on `auto`. Not applied on Windows or Linux:
  those binaries could not be measured here, and an unsupported flag makes llama-server exit at
  startup, which would take out every local inference in the app.
- **`--parallel 1` (rejected).** The experiment's premise was that the app's default of automatic
  slots divides the context. Measured, it does not: with slots on auto llama.cpp enables a unified
  KV buffer and reports the full 32,768-token context for every slot. Worse, llama-server routes a
  request to the slot whose prompt best matches it, so with four slots an unrelated dictation lands
  in a _different_ slot and the debrief's cached prefix survives where it is. One slot would force
  that prefix to be evicted every time anything else ran.
- **`--cache-ram 0` (rejected).** In a harness with one client the host-RAM prompt cache is pure
  overhead. In the app it is the mechanism that restores the prefix after another request evicts
  it, and it is already enabled — llama.cpp's default is 8192 MiB. The workload only ever caches
  about 9.4k tokens, so the cap is never approached and lowering it buys nothing.
- **`--ctx-checkpoints 8` (rejected).** A 4× reduction from the default of 32, adopted while tuning
  _12B_ for memory. No measured benefit on E4B.

The lesson generalises: an experiment harness with one client and one model is not the app. Three
of the five flags were tuned against conditions the app does not have.

## Coverage, and what still takes the old path

A section prompt is the transcript plus about 2,000 tokens of analysis, and the app refuses a
prompt over 60% of the model's context. At the 32,768-token context this model gets on a 24 GB
machine, that caps the debrief at roughly 17,600 tokens of transcript — comfortably more than the
median recorded meeting, but not the longest quarter of them. Those keep the existing
chunk-and-compose path, which does not cite timestamps and scores lower, but never truncates.
Raising that 60% share would extend the debrief further; it also guards every other local
inference in the app, so it is a separate change with its own measurements.

## Reproducing

The harness is not in this repository (it reads a hard-coded personal database path). With it
present at `experiments/notes-model/`:

```
M=~/.cache/openwhispr-experiments/models
python3 multipass.py <label> $M/gemma-4-E4B_q4_0-it.gguf \
  --pipeline pipelines/probes-app.json --note <id> \
  --system "$(cat ../../test/fixtures/debrief-prompts-en/system.txt)" \
  -fa on -ctk q8_0 -ctv q8_0
python3 score79.py <label>
```

Both harnesses refuse to start if a llama-server is already running, and kill the server if
system free memory falls below 8%.

## Model

`google/gemma-4-E4B-it-qat-q4_0-gguf` → `gemma-4-E4B_q4_0-it.gguf`, 4.8 GB, not gated. It is
quantisation-aware trained, which is why it beats the same size of post-training Q4_K_M quant on
every axis measured here: one point of score, 5 s of wall time, and 357 MB less peak working
memory. Both are offered in Settings.
