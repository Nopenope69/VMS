/**
 * AI provenance for evidence packages (P4.5): every AI-derived record for the exported camera and
 * time window, with the model that produced it (name, version, SHA-256, components), confidence,
 * frame timestamp and camera. Written into the package as ai_provenance.json and summarised in the
 * signed manifest; the offline verifier (tools/vigilone-verify) checks it.
 *
 * Classical motion events are not AI and are not listed. AI events stored without model
 * provenance (written before Phase 2) are counted as unattributed, never given a model.
 */
import { PrismaClient } from '@prisma/client';

export const AI_PROVENANCE_SCHEMA = 'vigilone.ai-provenance.v1';

export interface AiProvenanceModel {
  name: string;
  version: string;
  sha256: string;
  task: string | null;
  codeLicense: string | null;
  weightLicense: string | null;
  weightsSource: string | null;
  /** Published evaluation, or null: not evaluated on site data. */
  evaluation: unknown;
  registered: boolean;
}

export interface AiProvenanceRecord {
  kind: 'DETECTION' | 'PLATE_READ';
  id: string;
  cameraId: string;
  frameTimestampUtc: string;
  lastSeenUtc?: string;
  label: string;
  confidence: number;
  boundingBox?: unknown;
  model: { name: string; version: string; sha256: string };
  components: Array<{ role: string; modelName: string; modelVersion: string; modelSha256: string }>;
  adapterId: string | null;
  runtime: string | null;
  inferenceId: string | null;
}

export interface AiProvenanceDocument {
  schema: typeof AI_PROVENANCE_SCHEMA;
  cameraId: string;
  window: { startUtc: string; endUtc: string };
  statement: string;
  models: AiProvenanceModel[];
  records: AiProvenanceRecord[];
  unattributed: { count: number; ids: string[] };
}

/** DetectionEvent types that only an AI model produces (MOTION and camera/storage events are not AI). */
const AI_EVENT_TYPES = ['PERSON_DETECTED', 'VEHICLE_DETECTED'];

export async function collectAiProvenance(prisma: PrismaClient, tenantId: string, cameraId: string, start: Date, end: Date): Promise<AiProvenanceDocument> {
  const dets = await prisma.detectionEvent.findMany({
    where: { tenantId, cameraId, timestamp: { gte: start, lte: end } },
    orderBy: { timestamp: 'asc' },
  });
  const plates = await prisma.vehicleObservation.findMany({
    where: { tenantId, cameraId, firstSeenAt: { lte: end }, lastSeenAt: { gte: start } },
    orderBy: { firstSeenAt: 'asc' },
  });
  const records: AiProvenanceRecord[] = [];
  const unattributed: string[] = [];
  const shas = new Map<string, { name: string; version: string }>();
  const fromProv = (p: any) => {
    if (!p || typeof p !== 'object' || !/^[a-f0-9]{64}$/.test(p.modelSha256 || '') || !p.modelName || !p.modelVersion) return null;
    shas.set(p.modelSha256, { name: p.modelName, version: p.modelVersion });
    return p;
  };
  for (const d of dets) {
    const isAi = d.modelSha256 || d.provenanceJson || AI_EVENT_TYPES.includes(String(d.type));
    if (!isAi) continue;
    const p = fromProv(d.provenanceJson);
    if (!p) {
      unattributed.push(`detection:${d.id}`);
      continue;
    }
    records.push({
      kind: 'DETECTION',
      id: d.id,
      cameraId: d.cameraId,
      frameTimestampUtc: p.frameTimestampUtc || d.timestamp.toISOString(),
      label: d.objectClass || String(d.type),
      confidence: d.confidence,
      boundingBox: d.boundingBox ?? undefined,
      model: { name: p.modelName, version: p.modelVersion, sha256: p.modelSha256 },
      components: Array.isArray(p.components) ? p.components : [],
      adapterId: p.adapterId ?? null,
      runtime: p.runtime ?? null,
      inferenceId: p.inferenceId ?? d.inferenceId ?? null,
    });
  }
  for (const o of plates) {
    const p = fromProv(o.provenanceJson);
    if (!p) {
      unattributed.push(`plate:${o.id}`);
      continue;
    }
    records.push({
      kind: 'PLATE_READ',
      id: o.id,
      cameraId: o.cameraId,
      frameTimestampUtc: o.firstSeenAt.toISOString(),
      lastSeenUtc: o.lastSeenAt.toISOString(),
      label: o.normalizedPlate,
      confidence: o.bestConfidence,
      model: { name: p.modelName, version: p.modelVersion, sha256: p.modelSha256 },
      components: Array.isArray(p.components) ? p.components : [],
      adapterId: p.adapterId ?? null,
      runtime: p.runtime ?? null,
      inferenceId: p.inferenceId ?? null,
    });
  }
  const manifests = await prisma.modelManifest.findMany({ where: { sha256: { in: [...shas.keys()] } } });
  const models: AiProvenanceModel[] = [...shas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sha256, id]) => {
      const m = manifests.find((x) => x.sha256 === sha256 && x.name === id.name && x.version === id.version);
      return {
        name: id.name,
        version: id.version,
        sha256,
        task: m?.task ?? null,
        codeLicense: m?.codeLicense ?? null,
        weightLicense: m?.weightLicense ?? null,
        weightsSource: m?.weightsSource ?? null,
        evaluation: m?.evaluationJson ?? null,
        registered: Boolean(m),
      };
    });
  return {
    schema: AI_PROVENANCE_SCHEMA,
    cameraId,
    window: { startUtc: start.toISOString(), endUtc: end.toISOString() },
    statement:
      'AI-derived records are advisory metadata produced by the listed models. They are not part of the primary media and do not alter it. ' +
      'A model with evaluation null has not been evaluated on site data.',
    models,
    records,
    unattributed: { count: unattributed.length, ids: unattributed },
  };
}
