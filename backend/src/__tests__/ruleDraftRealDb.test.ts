import crypto from 'crypto';
import { PrismaClient, RuleTriggerType } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { setRuleDrafterForTests, RuleDrafter, RuleDraftError } from '../services/automation/ruleDraft.service';

jest.setTimeout(60000);

const prisma = new PrismaClient();

let app: { url: string; close: () => Promise<void> };
let tenantA = '';
let tenantB = '';
let cameraAId = '';
let cameraBId = '';
let adminA = { userId: '', token: '' };
let viewerA = { userId: '', token: '' };
const cleanupTenants: string[] = [];

async function api(method: string, p: string, body?: unknown, token = adminA.token) {
  const res = await fetch(`${app.url}/api/v1${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_NL_RULES = 'true';

  ({ tenantId: tenantA, cameraId: cameraAId } = await createTenantWithCamera(prisma, 'nl-rules-a', {
    timezone: 'Asia/Kolkata',
  }));
  ({ tenantId: tenantB, cameraId: cameraBId } = await createTenantWithCamera(prisma, 'nl-rules-b', {
    timezone: 'Asia/Kolkata',
  }));
  cleanupTenants.push(tenantA, tenantB);

  // Update camera names
  await prisma.camera.update({
    where: { id: cameraAId },
    data: { name: 'Server Room North' },
  });
  await prisma.camera.update({
    where: { id: cameraBId },
    data: { name: 'Secret Lab Camera' },
  });

  // Create a detection zone for tenantA
  await prisma.detectionZone.create({
    data: {
      tenantId: tenantA,
      cameraId: cameraAId,
      name: 'Server Room',
      polygonCoordinates: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
    },
  });

  adminA = await createUserWithToken(prisma, tenantA, 'TENANT_ADMIN');
  viewerA = await createUserWithToken(prisma, tenantA, 'VIEWER');

  app = await startApp();
});

afterAll(async () => {
  setRuleDrafterForTests(undefined);
  await app?.close();
  for (const t of cleanupTenants) {
    await prisma.tenant.deleteMany({ where: { id: t } });
  }
  await prisma.$disconnect();
});

describe('POST /api/v1/automation/rules/draft-nl', () => {
  it('returns 501 when FEATURE_NL_RULES is false', async () => {
    process.env.VIGILONE_FEATURE_NL_RULES = 'false';
    try {
      const res = await api('POST', '/automation/rules/draft-nl', {
        instruction: 'Alert on loitering',
      });
      expect(res.status).toBe(501);
      expect(res.json.code).toBe('FEATURE_DISABLED');
    } finally {
      process.env.VIGILONE_FEATURE_NL_RULES = 'true';
    }
  });

  it('requires AUTOMATION_MANAGE permission (403 for VIEWER, 401 for unauthenticated)', async () => {
    const unauth = await fetch(`${app.url}/api/v1/automation/rules/draft-nl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'Alert on loitering' }),
    });
    expect(unauth.status).toBe(401);

    const forbidden = await api('POST', '/automation/rules/draft-nl', {
      instruction: 'Alert on loitering',
    }, viewerA.token);
    expect(forbidden.status).toBe(403);
  });

  it('successfully drafts rule with mocked adapter response and real database entities', async () => {
    const mockDrafter: RuleDrafter = {
      extractIntent: async (_t, _inst, locations) => {
        expect(locations).toContain('Server Room');
        expect(locations).toContain('Server Room North');
        return {
          ir: {
            suggestedName: 'Server Room Loitering Alert After 10 PM',
            behavior: 'LOITERING',
            targetClass: 'person',
            locationPhrase: 'server room',
            durationSeconds: 300,
            schedule: {
              type: 'AFTER',
              startTime: '22:00',
              endTime: null,
              days: [0, 1, 2, 3, 4, 5, 6],
            },
            actionType: 'ALARM',
            severity: 'CRITICAL',
            unresolvedNotes: [],
          },
          promptSha256: 'a'.repeat(64),
        };
      },
    };

    setRuleDrafterForTests(mockDrafter);

    const res = await api('POST', '/automation/rules/draft-nl', {
      instruction: 'Alert if someone loiters near the server room for more than 5 minutes after 10 PM',
    });

    expect(res.status).toBe(200);
    expect(res.json.interpretation.status).toBe('ready_for_review');
    expect(res.json.draftRule.triggerType).toBe(RuleTriggerType.PERSON_DETECTED);
    expect(res.json.draftRule.triggerConfig.minDwellSeconds).toBe(300);
    expect(res.json.draftRule.triggerConfig.cameraId).toBe(cameraAId);
    expect(res.json.draftRule.conditions[0].type).toBe('TIME_SCHEDULE');
    expect(res.json.draftRule.conditions[0].value.windows[0].start).toBe('22:00');
    expect(res.json.draftRule.conditions[0].value.windows[0].end).toBe('06:00');
    expect(res.json.promptSha256).toBe('a'.repeat(64));

    // Check audit log was written
    const auditLogs = await prisma.auditEvent.findMany({
      where: {
        tenantId: tenantA,
        action: 'AUTOMATION_RULE_DRAFT_NL',
      },
    });
    expect(auditLogs.length).toBeGreaterThan(0);
  });

  it('enforces tenant isolation (only includes caller cameras and zones in context)', async () => {
    let capturedLocations: string[] = [];
    const mockDrafter: RuleDrafter = {
      extractIntent: async (_t, _inst, locations) => {
        capturedLocations = locations;
        return {
          ir: {
            suggestedName: 'Secret Lab Alert',
            behavior: 'AREA_INTRUSION',
            targetClass: 'person',
            locationPhrase: 'Secret Lab Camera',
            durationSeconds: null,
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
          promptSha256: 'b'.repeat(64),
        };
      },
    };

    setRuleDrafterForTests(mockDrafter);

    const res = await api('POST', '/automation/rules/draft-nl', {
      instruction: 'Alert on intrusion in secret lab',
    });

    expect(res.status).toBe(200);
    // Tenant B's camera must NOT be in tenant A's location vocabulary!
    expect(capturedLocations).not.toContain('Secret Lab Camera');
    // Resulting rule must flag needs_clarification since Secret Lab belongs to Tenant B
    expect(res.json.interpretation.status).toBe('needs_clarification');
    expect(res.json.interpretation.resolvedEntities.cameras).toHaveLength(0);
  });

  it('returns 503 when adapter is unreachable', async () => {
    const mockDrafter: RuleDrafter = {
      extractIntent: async () => {
        throw new RuleDraftError('AI_WORKER_UNAVAILABLE', 'Connection to llama-server refused');
      },
    };

    setRuleDrafterForTests(mockDrafter);

    const res = await api('POST', '/automation/rules/draft-nl', {
      instruction: 'Alert if someone loiters near the vault',
    });

    expect(res.status).toBe(503);
    expect(res.json.code).toBe('AI_WORKER_UNAVAILABLE');
  });
});
