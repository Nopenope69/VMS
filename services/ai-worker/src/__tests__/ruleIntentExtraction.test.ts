import fs from 'fs';
import path from 'path';
import {
  RuleIntentIRSchema,
  parseRuleIntentIR,
} from '../textllm/ruleIntentTypes';
import {
  cleanLocations,
  buildMessages,
  promptSha256,
  parseRuleIntent,
  SingleFlightLimiter,
  loadDefinition,
  resolveRuleDraftPipelinePath,
  LoadedRuleDraftPipeline,
  RuleDraftDefinition,
} from '../textllm/ruleDraftPipeline';
import { RuleDraftAdapterCore } from '../textllm/ruleDraftAdapterCore';
import { createAdapterServer } from '../adapter/httpServer';

const defPath = resolveRuleDraftPipelinePath();
const def: RuleDraftDefinition = JSON.parse(fs.readFileSync(defPath, 'utf8'));

describe('ruleIntentTypes', () => {
  it('parses a valid RuleIntentIR with complete fields', () => {
    const raw = {
      suggestedName: 'Server Room Loitering Alert After 10 PM',
      behavior: 'LOITERING',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: 300,
      schedule: {
        type: 'AFTER',
        startTime: '22:00',
        endTime: '06:00',
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const parsed = parseRuleIntentIR(raw);
    expect(parsed.suggestedName).toBe('Server Room Loitering Alert After 10 PM');
    expect(parsed.behavior).toBe('LOITERING');
    expect(parsed.targetClass).toBe('person');
    expect(parsed.locationPhrase).toBe('server room');
    expect(parsed.durationSeconds).toBe(300);
    expect(parsed.schedule.type).toBe('AFTER');
    expect(parsed.schedule.startTime).toBe('22:00');
    expect(parsed.actionType).toBe('ALARM');
    expect(parsed.severity).toBe('CRITICAL');
  });

  it('supplies safe defaults for optional fields', () => {
    const raw = {
      suggestedName: 'Fence Breach Alert',
      behavior: 'FENCE_CLIMB',
    };

    const parsed = parseRuleIntentIR(raw);
    expect(parsed.behavior).toBe('FENCE_CLIMB');
    expect(parsed.targetClass).toBe('any');
    expect(parsed.locationPhrase).toBeNull();
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.schedule.type).toBe('ALWAYS');
    expect(parsed.schedule.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parsed.actionType).toBe('ALARM');
    expect(parsed.severity).toBe('CRITICAL');
    expect(parsed.unresolvedNotes).toEqual([]);
  });

  it('rejects invalid behavior enums', () => {
    const raw = {
      suggestedName: 'Invalid Behavior Rule',
      behavior: 'TELEPORTATION',
    };

    expect(() => parseRuleIntentIR(raw)).toThrow();
  });

  it('rejects missing suggestedName', () => {
    const raw = {
      behavior: 'TRIPWIRE_CROSS',
    };

    expect(() => parseRuleIntentIR(raw)).toThrow();
  });
});

describe('ruleDraftPipeline', () => {
  it('validates rule-draft pipeline definition', () => {
    const { def: loadedDef, sha } = loadDefinition(defPath);
    expect(loadedDef.tasks).toContain('rule_draft');
    expect(loadedDef.generation.temperature).toBe(0);
    expect(loadedDef.generation.thinking).toBe(false);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });

  it('cleans and deduplicates locations deterministically', () => {
    const raw = ['Server Room', '  Front Gate  ', 'Server Room', 'Loading Dock'];
    const cleaned = cleanLocations(def, raw);
    expect(cleaned).toEqual(['Front Gate', 'Loading Dock', 'Server Room']);
  });

  it('builds chat messages including system prompt, examples, and user instruction', () => {
    const instruction = 'Alert if someone loiters near the vault';
    const locations = ['Vault', 'Front Desk'];
    const messages = buildMessages(def, instruction, locations);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Vault, Front Desk');
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: instruction,
    });
  });

  it('computes promptSha256 independent of location input order', () => {
    const h1 = promptSha256(def, cleanLocations(def, ['Zone B', 'Zone A']));
    const h2 = promptSha256(def, cleanLocations(def, ['Zone A', 'Zone B']));
    expect(h1).toBe(h2);
  });

  it('parses raw model JSON output and strips code fences', () => {
    const validJson = JSON.stringify({
      suggestedName: 'Vault Intrusion',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'vault',
      schedule: { type: 'ALWAYS' },
      actionType: 'ALARM',
      severity: 'CRITICAL',
    });

    const fenced = '```json\n' + validJson + '\n```';
    const parsed = parseRuleIntent(fenced);
    expect(parsed.behavior).toBe('AREA_INTRUSION');
    expect(parsed.suggestedName).toBe('Vault Intrusion');
  });

  it('rejects invalid or non-JSON model output', () => {
    expect(() => parseRuleIntent('Sorry, I cannot do that')).toThrow(/not valid JSON/);
    expect(() => parseRuleIntent(null)).toThrow(/the model returned no text/);
  });
});

describe('SingleFlightLimiter', () => {
  it('allows sequential executions and enforces maxQueue', async () => {
    const limiter = new SingleFlightLimiter(2);
    let running = 0;
    let maxConcurrent = 0;

    const task = async (ms: number) => {
      return limiter.run(async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        return 'done';
      });
    };

    const p1 = task(50);
    const p2 = task(50);
    const p3 = task(50);
    // 4th task exceeds queue depth 2 (1 in-flight + 2 queued = 3 max)
    await expect(task(50)).rejects.toThrow(/Inference worker busy/);

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['done', 'done', 'done']);
    expect(maxConcurrent).toBe(1);
  });
});

function createStandInPipeline(overrides: Partial<LoadedRuleDraftPipeline> = {}): LoadedRuleDraftPipeline {
  return {
    definition: def,
    definitionSha256: 'a'.repeat(64),
    components: [
      {
        role: 'rule_draft_model',
        entry: {
          name: 'Qwen3-4B-Instruct-GGUF',
          version: '1.0.0',
          sha256: 'a'.repeat(64),
          codeLicense: 'Apache-2.0',
          weightLicense: 'Apache-2.0',
          weightsSource: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-GGUF',
        } as any,
        approval: null,
        file: '/dev/null',
      },
    ],
    runtime: { buildInfo: 'test-build', binarySha256: 'b'.repeat(64) },
    extractIntent: async (instruction: string, locations: string[], _deadlineMs: number) => {
      return {
        ir: {
          suggestedName: 'Loitering Alert',
          behavior: 'LOITERING',
          targetClass: 'person',
          locationPhrase: locations[0] || 'lobby',
          durationSeconds: 300,
          schedule: {
            type: 'ALWAYS',
            startTime: null,
            endTime: null,
            days: [0, 1, 2, 3, 4, 5, 6],
          },
          actionType: 'ALARM',
          severity: 'CRITICAL',
          unresolvedNotes: [],
        },
        promptSha256: 'c'.repeat(64),
      };
    },
    alive: () => true,
    close: async () => {},
    ...overrides,
  };
}

describe('RuleDraftAdapterCore', () => {
  it('describes rule_draft model and handles rule intent extraction', async () => {
    const pipeline = createStandInPipeline();
    const core = new RuleDraftAdapterCore(pipeline, {
      adapterId: 'ai-rule-draft',
      adapterVersion: '1.0.0',
    });

    const desc = core.describe();
    expect(desc.tasks).toContain('rule_draft');

    const res = await core.handleRuleIntentRequest({
      instruction: 'Alert if someone loiters near lobby',
      locations: ['lobby'],
    });

    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.ruleIntent?.ir.behavior).toBe('LOITERING');
      expect(res.ruleIntent?.ir.durationSeconds).toBe(300);
      expect(res.provenance.modelName).toBe(def.name);
    }
  });

  it('serves POST /v1/extract-rule-intent via createAdapterServer', async () => {
    const pipeline = createStandInPipeline();
    const core = new RuleDraftAdapterCore(pipeline, {
      adapterId: 'ai-rule-draft',
      adapterVersion: '1.0.0',
    });

    const server = createAdapterServer(core);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;

    try {
      const res = await fetch(`${url}/v1/extract-rule-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: 'Alert on fence climb',
          locations: ['Perimeter'],
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.status).toBe('ok');
      expect(json.ruleIntent.ir.behavior).toBe('LOITERING');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

