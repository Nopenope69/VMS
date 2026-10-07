# Plain-language search: evaluation

Feature `NL_SEARCH`, endpoint `POST /api/v1/tracks/parse-query`, Find panel box "Ask in plain words".
Measured 2026-10-05 on CPU (4 threads), llama.cpp `b11277` (`eae11d2`), Qwen3-4B `Q4_K_M`
(`7485fe6f…34fdf5`), pipeline `scripts/models/pipelines/query-rewrite-qwen3-4b-v1.json`
(SHA-256 `22a53017…f82845b`, greedy decoding, thinking off).

## What is measured

A request such as "man in a blue shirt at Gate 3 last night, not a guard" is turned into the Find form's
filters: cameras, zone, object types, top, bottom and vehicle colour, direction, minimum time on scene, plate
read, time range, and the "also looks like" and "does not look like" terms. A case is **fully right** when every
labelled field matches and nothing extra is set. **Field accuracy** counts each field that is set in the label or
in the answer.

The labelled sets are in `backend/src/__tests__/fixtures/nl-search/`. Each lists the site's camera and zone names,
the time "now" (site time, Asia/Kolkata) and the expected filters.

| Set | Cases | How it was made |
| --- | --- | --- |
| `dev` | 40 | English, Hinglish and a little Hindi. Used to build the rules and the word list. |
| `holdout-1` | 30 | Written before the backend parser, but its misses were looked at while the word list was written, so it is **no longer a clean held-out set**. |
| `holdout-2` | 30 | Written before any run; scored once before the last rule change (see below). |
| `devanagari-1` | 20 | Written before any run, in Devanagari with Devanagari place names: the part the word list cannot read. |

These are requests written by the coding agent, not by operators. No request from a real site has been measured.

## Design, and why

Three designs were compared on `holdout-1` (the prototype rules, before the word list was finished):

| Design | Fully right | Field accuracy | Median time |
| --- | --- | --- | --- |
| Qwen3-1.7B fills the filters alone | 2/30 | 0.365 | |
| Qwen3-4B fills the filters alone | 8/30 | 0.466 | 7.5 s |
| Rules only (prototype) | 20/30 | 0.788 | under 1 ms |
| Rules, then Qwen3-1.7B rewrites what they cannot read | 22/30 | 0.869 | |
| Rules, then Qwen3-4B rewrites what they cannot read | 24/30 | 0.879 | |

A small local model asked to fill the filters directly gets times, colours and camera names wrong too often.
The product therefore uses **rules first**. Plain code reads the request with an English, Hinglish and
Devanagari word list. Only when words are left that the list cannot read (non-Latin script) is the request sent
to Qwen3-4B. The model is asked for **one thing**: the same request in plain English, keeping the site's camera
and zone names as given. The same rules then read that English.

What the rules read in the original request **always wins** over what they read in the rewrite. In testing the
model once turned "लाल ट्रक" (red truck) into "white truck"; with this merge the red stands. The operator sees what
was understood as removable parts, and the filled-in fields, before any search runs.

## Results (the shipped parser)

Command: `cd backend && npx ts-node scripts/eval/nl-search.ts` (rules only), and with the model:

```
# worker: the query-rewrite adapter (candidate model, evaluation only)
cd services/ai-worker && npm run build
QUERY_LLM_LLAMA_SERVER_BIN=/path/to/llama-server VIGILONE_MODEL_EXCEPTIONS=<approval file for qwen3-4b-q4km> \
  AI_WORKER_MODE=query-rewrite-adapter-only node dist/main.js        # listens on :7015
# backend
cd backend && npx ts-node scripts/eval/nl-search.ts --rewrite-url http://127.0.0.1:7015 \
  --model-id qwen3-4b-query-rewrite@1.0.0 --json out.json
```

| Set | Rules only | Rules + Qwen3-4B rewrite | Requests sent to the model |
| --- | --- | --- | --- |
| `dev` | 39/40 (0.992) | 39/40 (0.992) | 0 |
| `holdout-1` (not clean) | 29/30 (0.990) | 30/30 (1.000) | 1 |
| `holdout-2` | 29/30 (see below) | 30/30 (1.000) | 2 |
| `devanagari-1` | 0/20 (0.617) | 19/20 (0.984) | 20 |

- `holdout-2` scored **28/30 (0.969)** the first time it was run. One miss was "in the last hour" without a
  number, which was then fixed (29/30). Read the honest held-out figure as 28/30 for English and Hinglish.
- `devanagari-1` before the merge rule above: 15/20 (0.902). The one miss left is a labelling choice: "कोई"
  (someone) is read as a person, and the label left the type open.
- `dev`'s one miss: "brown dog" sets a vehicle colour; there is no dog class to search.
- Rewrite time: median 2.4 s, slowest 3.7 s (23 rewrites, CPU, 4 threads). Requests read by the rules alone
  answer in milliseconds and never reach the model.

## Limits

- The sets are small and written by the coding agent. A pilot needs operators' own requests, scored the same way.
- Times are read in the time zone of the tenant's first site. A tenant with sites in several time zones gets that
  one zone.
- Without the model (no `QUERY_LLM_ADAPTER_URL`) or when it fails, the answer is what the rules read. The Find
  panel says that some words could not be read and why.
- Qwen3-4B is a candidate in `models.lock.json` (Apache-2.0 weights, training data not fully disclosed). The owner
  approved running it in the product on 2026-10-07 (`model-license-exceptions.json`); this is a business decision,
  not a legal clearance. The approval is checked against the model's SHA-256.
- The model rewrites text only. It never sees video, and it never sets a filter itself.
