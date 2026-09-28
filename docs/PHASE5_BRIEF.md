# Phase 5 brief: search and verification

Source: VigilOne Action Plan to the North Star, Phase 5. Written after Phases 2–4 landed on `master`.

**Goal (from the plan):**
- Search recorded footage in natural language, e.g. "white van near gate 2 after 10pm".
- Optionally have a local vision-language model (VLM) double-check borderline alarms.
- Never identify individuals.
- With every new flag off, behaviour must be identical to Phase 4.

### P5.1 pgvector database
- **Postgres image.** Switch it to a pgvector build (`pgvector/pgvector:pg16`) in:
  - `docker-compose.yml`;
  - the Postgres **service containers in `.github/workflows/ci.yml`**: both the backend job and the AI e2e job, or CI breaks.
- **Migration.** Add a Prisma migration running `CREATE EXTENSION IF NOT EXISTS vector`. Then add an `ObjectEmbedding` table with:
  - tenant, camera and track ID;
  - a reference to the crop image file;
  - model manifest ID;
  - time;
  - the vector itself.
- **Vector column.** Prisma has no vector type. Use `Unsupported("vector(768)")` in the schema, and raw SQL for inserts and similarity queries. Add an HNSW index.
- **Migration test.** Every migration needs one; copy `backend/src/__tests__/migrationPhase4Dpdp.test.ts`.

### P5.2 Embedding worker
- **Model.** SigLIP 2 exported to ONNX. It needs an image encoder for crops and a text encoder for queries.
- **Licence first.** Check the weights' licence *before* adding them.
  - The code is Apache-2.0, but the training data (WebLI) is unpublished. That makes it a **candidate model**, the same as the ANPR and redaction models.
  - Put it in `candidateModels` in `scripts/models/models.lock.json` with a `governance` note.
  - It must refuse to run in production without a human approval for its exact SHA-256.
  - It must pass `npm run check:model-licenses`, and be listed in `THIRD_PARTY_LICENSES.md`.
- **Worker pattern.** Copy an existing adapter:
  - `services/ai-worker/src/redaction/` (pipeline loader and adapter core);
  - `scripts/models/pipelines/*.json` (pinned pipeline definitions);
  - `verifyPipelineComponents()` in `anpr/anprService.ts`.
- **Contract.** The `embedding` task already exists in the ai-adapter.v1 contract. A text-query task has to be added in **both** copies of the contract:
  - `backend/src/contracts/aiAdapter.v1.ts`;
  - `services/ai-worker/src/adapter/contract.ts`.
- **Crops.** One crop per tracked object (the best frame of a track), not one per frame.
- **Backfill job.** Rate-limited, low priority, and it pauses when the recording watchdogs report trouble. It must **never starve recording**.
- **Conformance.** Run the conformance kit against the new adapter; it must pass 19/19: `cd backend && npm run conformance:ai-adapter -- --url <adapter URL>`.
- **Golden test.** The TypeScript port must match a Python reference on committed fixtures, as `goldenAnpr.test.ts` and `goldenYunet.test.ts` do.

### P5.3 Natural-language search API and UI
- **API.** Combine text-to-image similarity with structured filters: camera, time range, object class, zone.
- **UI.**
  - Example-query chips.
  - A results timeline where clicking a result jumps to playback at that moment (the playback routes already exist).
  - Extend the existing `smartSearch` routes and service rather than starting a new one.
- **Moderation filter.** Refuse queries aimed at identifying people or at protected attributes (names, face matching, race, religion, and so on). Refusals return an explicit error code and are audited.
- **DPDP (Phase 4 controls apply).**
  - Search queries go through `requirePurpose()` and `recordSensitiveQuery()` in `backend/src/services/privacy/dataProtection.service.ts`, with an RBAC permission and an audit record per query.
  - The retention purge (`purgeTenant()` in the same file) **must be extended to delete crops and embeddings**. Its header comment already says so.

### P5.4 VLM alert verification (optional, flag default OFF)
- **Client.** Talks to a local OpenAI-compatible endpoint, with strict timeouts.
- **Scope.** Only borderline events are sent, for example detections in a confidence band.
- **Stored result.** A structured JSON verdict plus a readable reason, stored with the model ID and provenance.
- **Air-gapped mode** blocks external endpoints; reuse what notifications already do.
- **Feature flag.** New flag in `backend/src/config/featureFlags.ts`. Then run `npm run docs:feature-flags`, or the CI check that the README flag table matches the code fails.
- **Failure behaviour.** If the VLM times out or errors, the alarm stands with "not verified". A VLM failure must never suppress or delay an alarm.

### P5.5 Verification harness
- **What it measures:** false-alarm reduction and added latency, on a labelled event set.
- **Pattern to copy:** `services/ai-worker/src/tools/evalPlates.ts`. The dataset declares itself SITE or SYNTHETIC, and the harness refuses to run if test data leaked into training.
- **Data.** Real numbers need labelled events **from you**. Anything run on made-up data is labelled SYNTHETIC.

### Acceptance (from the plan)
- Search latency and recall measured and published.
- VLM verdicts logged with provenance.
- Flag off means behaviour identical to Phase 4.

---

## Rules Copilot must follow (they bit me in Phases 2–4)
1. **No fake success.**
   - Anything that can't do the real thing fails with an explicit error code.
   - Never hard-code a version, hash or metric. `npm run check:no-fake-success` catches literals such as `'1.30.0'`.
   - Mocks belong only in tests.
2. **Every new subsystem ships with:**
   - unit tests;
   - one real-database/HTTP integration test (copy `dpdpRealDb.test.ts`);
   - Prometheus metrics;
   - audit records for privileged actions;
   - a doc page in `docs/operations/`.
3. **CI shares one real database and runs about 2 test workers.**
   - Tests must create their own tenant and clean up.
   - Model names and versions in test fixtures must be unique per run.
   - Real-DB suites set `jest.setTimeout(60000)`.
4. **Before pushing, run:**
   - `cd backend && npx jest --maxWorkers=2` (matches CI);
   - `npm run check:model-licenses`, `check:no-fake-success`, `check:dependency-licenses`, `check:feature-flag-docs` and `check:hygiene`;
   - `cd services/ai-worker && npm run build && npx jest`;
   - `cd frontend && npm run build && npm run check:no-demo`.
5. **Record progress.**
   - Update `docs/STATUS.md` with real commands and outputs; anything not verified goes under "Not verified".
   - Out-of-scope items go to `docs/BACKLOG.md`.
   - One PR for the phase, branched from `master`.
6. **Licences:** MIT, Apache-2.0, BSD or ISC only. If unclear, don't add it; list it under "Licence questions" in STATUS.

## What only you can supply
- **Licence decision on the SigLIP 2 weights**, then an approval entry for their exact SHA-256.
- **A labelled set of search queries with expected results**, to measure recall.
- **Labelled real alarms (true and false)** to measure VLM false-alarm reduction.
- **A machine that can run a local VLM**, if you want P5.4. It will be slow or impossible without a GPU.
