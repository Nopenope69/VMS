import { PrismaClient } from '@prisma/client';
import { isNlRulesEnabled } from '../../config/featureFlags';
import { setting } from '../../config/settings';
import { AiAdapterClient } from '../ai/aiAdapterClient';
import { compileRuleIntent } from './ruleCompiler';
import {
  RuleIntentIR,
  RuleCompileResult,
  parseRuleIntentIR,
} from './ruleIntentTypes';

export class RuleDraftError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuleDraftError';
  }
}

export interface RuleDrafter {
  extractIntent(
    tenantId: string,
    instruction: string,
    locations: string[]
  ): Promise<{ ir: RuleIntentIR; promptSha256: string }>;
}

let testOverrideDrafter: RuleDrafter | null | undefined;

export function setRuleDrafterForTests(d: RuleDrafter | null | undefined): void {
  testOverrideDrafter = d;
}

export class RuleDraftService {
  constructor(private readonly prisma: PrismaClient) {}

  private getDrafter(): RuleDrafter {
    if (testOverrideDrafter !== undefined && testOverrideDrafter !== null) {
      return testOverrideDrafter;
    }
    const url = setting('RULE_LLM_ADAPTER_URL') || process.env.QUERY_LLM_ADAPTER_URL;
    if (!url) {
      throw new RuleDraftError(
        'AI_WORKER_UNAVAILABLE',
        'No rule draft adapter configured (RULE_LLM_ADAPTER_URL or QUERY_LLM_ADAPTER_URL)'
      );
    }
    const adapterClient = new AiAdapterClient(url, {
      name: 'rule draft adapter',
      timeoutMs: 15000,
      fail: (kind, msg) =>
        new RuleDraftError(kind === 'unavailable' ? 'AI_WORKER_UNAVAILABLE' : 'RULE_DRAFT_FAILED', msg),
    });

    return {
      extractIntent: async (tenantId: string, instruction: string, locations: string[]) => {
        const res = await adapterClient.call('/v1/extract-rule-intent', {
          tenantId,
          instruction,
          locations: locations.slice(0, 64),
          deadlineMs: 15000,
        });
        if (!res.ruleIntent?.ir) {
          throw new RuleDraftError('RULE_DRAFT_FAILED', 'Adapter did not return rule intent');
        }
        return {
          ir: parseRuleIntentIR(res.ruleIntent.ir),
          promptSha256: res.ruleIntent.promptSha256,
        };
      },
    };
  }

  async draftRule(
    tenantId: string,
    instruction: string
  ): Promise<RuleCompileResult & { promptSha256: string }> {
    if (!isNlRulesEnabled()) {
      throw new RuleDraftError('FEATURE_DISABLED', 'Describe-What-To-Watch Rules feature is disabled');
    }
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      throw new RuleDraftError('INVALID_PROMPT', 'Instruction must be a non-empty string');
    }

    // 1. Gather tenant-isolated cameras, zones, and site timezone
    const [cameras, zones, sites] = await Promise.all([
      this.prisma.camera.findMany({
        where: { tenantId },
        select: { id: true, name: true, tenantId: true },
      }),
      this.prisma.detectionZone.findMany({
        where: { tenantId },
        select: { id: true, name: true, tenantId: true, cameraId: true },
      }),
      this.prisma.site.findMany({
        where: { tenantId },
        select: { timezone: true },
        take: 1,
      }),
    ]);

    const locations = [...new Set([...zones.map((z) => z.name), ...cameras.map((c) => c.name)])];
    const drafter = this.getDrafter();

    // 2. Extract intent via local Qwen3-4B adapter
    const { ir, promptSha256 } = await drafter.extractIntent(
      tenantId,
      instruction.trim(),
      locations
    );

    // 3. Compile deterministically with semantic validation
    const compiled = compileRuleIntent(ir, {
      tenantId,
      cameras,
      zones,
      timezone: sites[0]?.timezone || 'Asia/Kolkata',
    });

    return {
      ...compiled,
      promptSha256,
    };
  }
}
