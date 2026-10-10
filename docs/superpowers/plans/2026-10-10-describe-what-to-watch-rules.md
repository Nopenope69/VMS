# Describe-What-To-Watch Rules (Natural Language Rules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow security operators to describe automation rules in plain language (English, Hinglish, Hindi), extract intent into a typed intermediate representation using local Qwen3-4B, compile it via a deterministic backend compiler into a validated `AutomationRule`, preview it against historical stored events, and confirm before saving.

**Architecture:** Two-stage architecture preserving the invariant *"AI proposes; the deterministic rule engine acts"*. Stage 1 uses local Qwen3-4B via `ai-worker` (`ai-adapter.v1.2`) to output a strictly typed `RuleIntentIR`. Stage 2 uses a deterministic backend compiler (`ruleCompiler.ts`) to resolve physical locations against tenant cameras/zones, enforce dwell thresholds and time schedules with visible assumptions, and validate via `validateRuleInput`. The operator reviews the populated form and historical event replay results in `EventActionRuleModal.tsx` before explicitly saving.

**Tech Stack:** TypeScript, Node.js / Express, Prisma / PostgreSQL, Zod, React, Vite, Playwright, llama.cpp / Qwen3-4B GGUF.

**Spec:** `docs/superpowers/specs/2026-10-09-describe-what-to-watch-rules-design.md`

## Global Constraints

- **Invariant:** Generative AI is strictly an authoring assistant; it never creates or activates an automation rule directly.
- **Fail-Closed:** Malformed or ambiguous model output is rejected by semantic and structural Zod validators; manual rule creation remains 100% operational.
- **Resource Protection:** Inference concurrency capped to 1 (single-flight queue); CPU bounded to max 2 threads; process priority `nice +10`; 15-second strict timeout.
- **Multi-Tenant Isolation:** All referenced cameras, zones, and spatial rules must belong to the caller's tenant; cross-tenant references are rejected.
- **Feature Gating:** Protected by feature flag `FEATURE_NL_RULES` (default `false` in production).

---

## File Structure & Responsibilities

### AI Worker (`services/ai-worker/`)
- `scripts/models/pipelines/rule-draft-qwen3-4b-v1.json`: Pinned pipeline configuration for Qwen3-4B with constrained JSON schema and few-shot surveillance prompt examples.
- `services/ai-worker/src/textllm/ruleIntentTypes.ts`: Zod schema and TypeScript interfaces for `RuleIntentIR`.
- `services/ai-worker/src/textllm/ruleDraftPipeline.ts`: Pipeline loader and execution wrapper for llama-server.
- `services/ai-worker/src/textllm/ruleDraftAdapterCore.ts`: `RuleDraftAdapterCore` extending `PipelineAdapterCore` for task `rule_draft`.
- `services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts`: AI-worker unit test verifying IR schema extraction and context sanitization.

### Backend (`backend/`)
- `backend/src/config/featureFlags.ts`: Add `FEATURE_NL_RULES`.
- `docs/operations/FEATURE_FLAGS.md`: Documentation for `FEATURE_NL_RULES`.
- `backend/src/services/automation/ruleIntentTypes.ts`: Backend definition of `RuleIntentIR` and review statuses (`ready_for_review`, `needs_clarification`, `unsupported_request`).
- `backend/src/services/automation/ruleCompiler.ts`: Deterministic compiler translating `RuleIntentIR` + tenant context into `RuleInputSchema` with explicit assumption tracking.
- `backend/src/services/automation/ruleDraft.service.ts`: Service orchestrating context gathering, AI-worker adapter calls, compilation, and error handling.
- `backend/src/routes/automation.routes.ts`: Add `POST /api/v1/automation/rules/draft-nl`.
- `backend/src/__tests__/ruleCompiler.test.ts`: Unit test suite testing 100% deterministic compilation logic and edge cases.
- `backend/src/__tests__/ruleDraftRealDb.test.ts`: Real PostgreSQL integration test testing the route, RBAC, tenant isolation, and error paths.

### Frontend (`frontend/`)
- `frontend/src/components/EventActionRuleModal.tsx`: Natural language prompt bar, interpretation card, draft population, and historical event replay display.
- `frontend/e2e/nl-rules.spec.ts`: Playwright browser test verifying the complete operator flow.

---

### Task 1: Feature Flag & Configuration

**Files:**
- Modify: `backend/src/config/featureFlags.ts`
- Modify: `backend/src/config/settings.ts`
- Modify: `docs/operations/FEATURE_FLAGS.md`
- Test: `backend/src/__tests__/settings.test.ts`

**Interfaces:**
- Produces: `isNlRulesEnabled(tenantId?: string): boolean` in `backend/src/config/featureFlags.ts`

- [ ] **Step 1: Write the failing test**

In `backend/src/__tests__/settings.test.ts`, add a test verifying `FEATURE_NL_RULES` defaults to `false` and can be read.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest backend/src/__tests__/settings.test.ts -t "FEATURE_NL_RULES"`  
Expected: FAIL

- [ ] **Step 3: Implement feature flag**

In `backend/src/config/featureFlags.ts`, add `FEATURE_NL_RULES: 'FEATURE_NL_RULES'` and helper `isNlRulesEnabled()`.  
Update `docs/operations/FEATURE_FLAGS.md` documenting the flag.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest backend/src/__tests__/settings.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/featureFlags.ts backend/src/config/settings.ts docs/operations/FEATURE_FLAGS.md backend/src/__tests__/settings.test.ts
git commit -m "feat(automation): add FEATURE_NL_RULES feature flag"
```

---

### Task 2: AI Worker `RuleIntentIR` Types & Pipeline Definition

**Files:**
- Create: `services/ai-worker/src/textllm/ruleIntentTypes.ts`
- Create: `scripts/models/pipelines/rule-draft-qwen3-4b-v1.json`
- Test: `services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts`

**Interfaces:**
- Produces: `RuleIntentIR`, `RuleIntentIRSchema`, `parseRuleIntentIR()` in `services/ai-worker/src/textllm/ruleIntentTypes.ts`

- [ ] **Step 1: Write the failing test for `ruleIntentTypes.ts`**

In `services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts`:
Test that `RuleIntentIRSchema.parse()` accepts a valid IR object (with behavior, durationSeconds, schedule, locationPhrase) and rejects invalid behavior enums or missing fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-worker && npx jest src/__tests__/ruleIntentExtraction.test.ts`  
Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement `ruleIntentTypes.ts` and pipeline definition**

Create `services/ai-worker/src/textllm/ruleIntentTypes.ts` with Zod schema defining `RuleIntentIR`.  
Create `scripts/models/pipelines/rule-draft-qwen3-4b-v1.json` referencing `qwen3-4b-q4km` with constrained schema and prompt examples.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/ai-worker && npx jest src/__tests__/ruleIntentExtraction.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/ai-worker/src/textllm/ruleIntentTypes.ts scripts/models/pipelines/rule-draft-qwen3-4b-v1.json services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts
git commit -m "feat(ai-worker): add rule intent IR schema and Qwen3-4B pipeline definition"
```

---

### Task 3: AI Worker `RuleDraftAdapterCore` & Route Handler

**Files:**
- Create: `services/ai-worker/src/textllm/ruleDraftPipeline.ts`
- Create: `services/ai-worker/src/textllm/ruleDraftAdapterCore.ts`
- Modify: `services/ai-worker/src/worker.ts`
- Test: `services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts`

**Interfaces:**
- Consumes: `RuleIntentIR`, `RuleIntentIRSchema`
- Produces: `RuleDraftAdapterCore` serving task `rule_draft` on `POST /v1/extract-rule-intent`

- [ ] **Step 1: Write unit tests for `RuleDraftPipeline` message building and single-flight queue**

Add tests to `services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts` testing vocabulary sanitization, prompt hashing, and single-flight concurrency lock.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-worker && npx jest src/__tests__/ruleIntentExtraction.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `ruleDraftPipeline.ts` and `ruleDraftAdapterCore.ts`**

Implement pipeline loader with single-flight concurrency lock (max concurrency 1) and 15s deadline.  
Implement `RuleDraftAdapterCore` extending `PipelineAdapterCore`. Wire into `services/ai-worker/src/worker.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/ai-worker && npx jest src/__tests__/ruleIntentExtraction.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/ai-worker/src/textllm/ruleDraftPipeline.ts services/ai-worker/src/textllm/ruleDraftAdapterCore.ts services/ai-worker/src/worker.ts services/ai-worker/src/__tests__/ruleIntentExtraction.test.ts
git commit -m "feat(ai-worker): implement RuleDraftAdapterCore with single-flight concurrency"
```

---

### Task 4: Backend Deterministic Rule Compiler

**Files:**
- Create: `backend/src/services/automation/ruleIntentTypes.ts`
- Create: `backend/src/services/automation/ruleCompiler.ts`
- Test: `backend/src/__tests__/ruleCompiler.test.ts`

**Interfaces:**
- Consumes: `RuleIntentIR`, `RuleInputSchema`, `validateRuleInput`
- Produces: `compileRuleIntent(ir: RuleIntentIR, context: RuleCompilerContext): CompileResult`

- [ ] **Step 1: Write exhaustive unit tests for `ruleCompiler.ts`**

In `backend/src/__tests__/ruleCompiler.test.ts`:
- Test 1: 5 minutes converts to exactly 300s dwell threshold on `SPATIAL_LOITERING`.
- Test 2: Location "server room" cleanly resolves to zone "Server Room".
- Test 3: Location "gate" with multiple gates flags `needs_clarification`.
- Test 4: "After 10 PM" compiles to `22:00-06:00` with an explicit assumption note.
- Test 5: "Between 9 AM and 5 PM" compiles with zero assumptions.
- Test 6: Cross-tenant camera ID is rejected.
- Test 7: Output validates against `RuleInputSchema`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest backend/src/__tests__/ruleCompiler.test.ts`  
Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement `ruleCompiler.ts`**

Implement `compileRuleIntent`:
- Normalized entity matcher for cameras and zones.
- Dwell time & spatial parameters mapper.
- Schedule window generator with assumption tracking.
- Action & grouping generator (`TRIGGER_ALARM` with `incidentWindowSeconds`).
- Zod schema validation using `validateRuleInput`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest backend/src/__tests__/ruleCompiler.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/automation/ruleIntentTypes.ts backend/src/services/automation/ruleCompiler.ts backend/src/__tests__/ruleCompiler.test.ts
git commit -m "feat(automation): add deterministic rule compiler with semantic validation"
```

---

### Task 5: Backend Service & Route Handler (`POST /rules/draft-nl`)

**Files:**
- Create: `backend/src/services/automation/ruleDraft.service.ts`
- Modify: `backend/src/routes/automation.routes.ts`
- Test: `backend/src/__tests__/ruleDraftRealDb.test.ts`

**Interfaces:**
- Consumes: `compileRuleIntent`, `AiAdapterClient`
- Produces: `POST /api/v1/automation/rules/draft-nl` returning `{ status, interpretation, draftRule, promptSha256 }`

- [ ] **Step 1: Write integration tests for route `draft-nl`**

In `backend/src/__tests__/ruleDraftRealDb.test.ts`:
- Test 1: Returns 501 when `FEATURE_NL_RULES` is false.
- Test 2: Requires `AUTOMATION_MANAGE` permission.
- Test 3: Successfully drafts rule with mocked adapter response and real database entities.
- Test 4: Enforces tenant isolation (only includes caller's cameras/zones in context).
- Test 5: Returns 503 when adapter is unreachable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest backend/src/__tests__/ruleDraftRealDb.test.ts`  
Expected: FAIL (route 404)

- [ ] **Step 3: Implement service and route**

Implement `RuleDraftService.draft(tenantId, prompt, options)`.  
Add `POST /rules/draft-nl` in `backend/src/routes/automation.routes.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest backend/src/__tests__/ruleDraftRealDb.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/automation/ruleDraft.service.ts backend/src/routes/automation.routes.ts backend/src/__tests__/ruleDraftRealDb.test.ts
git commit -m "feat(automation): add POST /api/v1/automation/rules/draft-nl endpoint"
```

---

### Task 6: Frontend Rule Builder Modal AI Prompt Bar & Replay Display

**Files:**
- Modify: `frontend/src/components/EventActionRuleModal.tsx`
- Test: `frontend/e2e/nl-rules.spec.ts`

**Interfaces:**
- Consumes: `POST /api/v1/automation/rules/draft-nl`, `POST /api/v1/automation/rules/preview`

- [ ] **Step 1: Implement AI prompt bar and interpretation card in `EventActionRuleModal.tsx`**

- Add AI prompt input bar at top of "Create Rule" tab.
- Add "Draft Rule" button with loading spinner.
- On response:
  - Populate form fields (`name`, `triggerType`, `draft`, `cooldownSeconds`, `actions`).
  - Render Interpretation & Assumptions card with status pill (`ready_for_review`, `needs_clarification`, `unsupported_request`).
  - Automatically invoke `handlePreview()` to run 7-day Historical Event Replay.
  - Display clear disclaimer: *"Evaluated against stored historical events. Does not re-run CV models on raw video."*

- [ ] **Step 2: Write Playwright E2E spec `frontend/e2e/nl-rules.spec.ts`**

Write E2E test verifying:
1. Operator navigates to Alarms $\rightarrow$ Automation Rules.
2. Enters plain language prompt into AI bar.
3. Observes pre-populated fields and interpretation card.
4. Observes historical replay results.
5. Edits a field, clicks "Save Rule", and verifies active rule in table.

- [ ] **Step 3: Run frontend build and typecheck**

Run: `cd frontend && npm run build`  
Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/EventActionRuleModal.tsx frontend/e2e/nl-rules.spec.ts
git commit -m "feat(ui): add AI rule drafting bar and interpretation review card"
```

---

### Task 7: Semantic Accuracy Evaluation Suite & Repository Gates

**Files:**
- Create: `tools/eval/rule-draft-eval.ts`
- Modify: `docs/STATUS.md`
- Modify: `PROJECT_STATE.md`

- [ ] **Step 1: Create semantic accuracy benchmark `tools/eval/rule-draft-eval.ts`**

Include 30+ labelled test prompts covering:
- English, Hinglish, and Hindi instructions.
- Dwell time parsing (minutes, seconds).
- Overnight vs daytime schedules.
- Ambiguity & prompt injection rejection.

- [ ] **Step 2: Run all repo validation gates**

```bash
npm run check:hygiene
npm run check:no-fake-success
npm run check:feature-flag-docs
npm run check:dependency-licenses
npm run check:model-licenses
npm run check:status-docs
```
Expected: All 6 gates PASS.

- [ ] **Step 3: Run backend and AI-worker test suites**

```bash
cd backend && npm test
cd ../services/ai-worker && npm test
```
Expected: All suites PASS.

- [ ] **Step 4: Update session status in `docs/STATUS.md` and `PROJECT_STATE.md`**

Record the new Session notes, feature flag, verified tests, and limits honestly.

- [ ] **Step 5: Commit**

```bash
git add tools/eval/rule-draft-eval.ts docs/STATUS.md PROJECT_STATE.md
git commit -m "docs(status): record Describe-What-To-Watch Rules implementation and verification"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-10-describe-what-to-watch-rules.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
