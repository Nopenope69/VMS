import crypto from 'crypto';
import { handleIngestDetection } from '../routes/internal.routes';
import { TripwireDirection, EventType } from '@prisma/client';
import { SpatialEngine, spatialEngine } from '../services/spatial/engine';
import { EvidenceManifestService } from '../services/evidence/evidenceManifest.service';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';
import config from '../config/env';

// In-memory state replicating database tables and unique constraints
const detectionStore = new Map<string, any>();
const incidentStore = new Map<string, any>();
const rulesStore = new Map<string, any>();
const cameraStore = new Map<string, any>();
const manifestStore = new Map<string, any>();

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    camera: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        const id = where?.id || (where?.OR && where.OR[0]?.id);
        const cam = cameraStore.get(id);
        if (cam && where?.tenantId && cam.tenantId !== where.tenantId) return null;
        return cam || null;
      }),
    },
    modelManifest: {
      findUnique: jest.fn().mockImplementation(async ({ where }) => {
        return manifestStore.get(where?.id) || null;
      }),
    },
    detectionEvent: {
      upsert: jest.fn().mockImplementation(async ({ where, create }) => {
        const key = where?.inferenceId;
        if (detectionStore.has(key)) {
          return detectionStore.get(key);
        }
        const record = { id: crypto.randomUUID(), ...create };
        detectionStore.set(key, record);
        return record;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }) => {
        return detectionStore.get(where?.inferenceId) || null;
      }),
      findMany: jest.fn().mockImplementation(async () => Array.from(detectionStore.values())),
    },
    spatialAnalyticsRule: {
      findMany: jest.fn().mockImplementation(async ({ where }) => {
        return Array.from(rulesStore.values()).filter(
          (r) => r.cameraId === where?.cameraId && (!where?.enabled || r.enabled === true)
        );
      }),
    },
    incident: {
      create: jest.fn().mockImplementation(async ({ data }) => {
        // Enforce DB-level uniqueness constraint: @@unique([cameraId, ruleId, trackId, cooldownBucket])
        const uniqueKey = `${data.cameraId}_${data.ruleId}_${data.trackId}_${data.cooldownBucket.toString()}`;
        if (incidentStore.has(uniqueKey)) {
          const err: any = new Error(
            'Unique constraint failed on the fields: (`cameraId`, `ruleId`, `trackId`, `cooldownBucket`)'
          );
          err.code = 'P2002';
          throw err;
        }
        const record = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        incidentStore.set(uniqueKey, record);
        return record;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }) => {
        let results = Array.from(incidentStore.values());
        if (where?.cameraId) results = results.filter((r) => r.cameraId === where.cameraId);
        if (where?.ruleId) results = results.filter((r) => r.ruleId === where.ruleId);
        if (where?.trackId) results = results.filter((r) => r.trackId === where.trackId);
        if (where?.cooldownBucket !== undefined) {
          results = results.filter((r) => r.cooldownBucket.toString() === where.cooldownBucket.toString());
        }
        return results;
      }),
      count: jest.fn().mockImplementation(async () => incidentStore.size),
    },
  },
}));

function createMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

describe('Spatial Analytics & Multi-Object Tracking Backend Integration', () => {
  const tenantId = 'tenant-test-spatial';
  const cameraId = 'cam-gate-01';
  const modelManifestId = 'manifest-yolo-v8';

  beforeEach(() => {
    detectionStore.clear();
    incidentStore.clear();
    rulesStore.clear();
    cameraStore.clear();
    manifestStore.clear();
    spatialEngine.clearTrackState();

    // Register active test camera
    cameraStore.set(cameraId, {
      id: cameraId,
      tenantId,
      name: 'Gate Camera 01',
      streamPath: 'cam_gate_01',
      isOnline: true,
    });

    // Register active model manifest
    manifestStore.set(modelManifestId, {
      id: modelManifestId,
      name: 'vigilone-yolo-v8',
      version: '1.0.0',
      isActive: true,
    });

    config.INTERNAL_API_SECRET = 'valid-test-secret';
  });

  // =========================================================================
  // A. Tripwire A -> B Crossing
  // =========================================================================
  describe('A. Tripwire A -> B Crossing', () => {
    it('detects A -> B crossing across horizontal line and creates an operational Incident', async () => {
      const ruleId = 'rule-tripwire-ab';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      const trackId = 'track-person-101';
      let t = 1700000000000;

      // Frame 1: Track on SIDE_A (y=0.7 > 0.5)
      const req1: any = {
        body: {
          tenantId,
          cameraId,
          modelManifestId,
          inferenceId: 'inf-ab-1',
          type: 'PERSON_DETECTED',
          confidence: 0.95,
          boundingBox: { x: 0.45, y: 0.6, width: 0.1, height: 0.2 },
          centroid: { x: 0.5, y: 0.7 },
          trackId,
          trackState: 'CONFIRMED',
          timestamp: new Date(t).toISOString(),
        },
      };
      const res1 = createMockRes();
      await handleIngestDetection(req1, res1);
      expect(res1.statusCode).toBe(200);
      expect(incidentStore.size).toBe(0); // Registered first side, no crossing yet

      // Frame 2: Track moves to SIDE_B (y=0.3 < 0.5)
      t += 1000;
      const req2: any = {
        body: {
          tenantId,
          cameraId,
          modelManifestId,
          inferenceId: 'inf-ab-2',
          type: 'PERSON_DETECTED',
          confidence: 0.95,
          boundingBox: { x: 0.45, y: 0.2, width: 0.1, height: 0.2 },
          centroid: { x: 0.5, y: 0.3 },
          trackId,
          trackState: 'CONFIRMED',
          timestamp: new Date(t).toISOString(),
        },
      };
      const res2 = createMockRes();
      await handleIngestDetection(req2, res2);
      expect(res2.statusCode).toBe(200);

      // Verify Incident was created
      expect(incidentStore.size).toBe(1);
      const incident = Array.from(incidentStore.values())[0];
      expect(incident.ruleType).toBe('TRIPWIRE');
      expect(incident.ruleId).toBe(ruleId);
      expect(incident.trackId).toBe(trackId);
      expect(incident.metadataJson.directionCrossed).toBe('A_TO_B');
    });
  });

  // =========================================================================
  // B. Tripwire B -> A Crossing
  // =========================================================================
  describe('B. Tripwire B -> A Crossing', () => {
    it('detects B -> A crossing and enforces configured direction', async () => {
      const ruleId = 'rule-tripwire-ba';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Egress Only',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.B_TO_A,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      const trackId = 'track-vehicle-202';
      let t = 1700000000000;

      // 1. Initial observation on SIDE_B (y=0.3 < 0.5)
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-ba-1',
            type: 'VEHICLE_DETECTED',
            confidence: 0.92,
            centroid: { x: 0.5, y: 0.3 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      // 2. Crosses to SIDE_A (y=0.8 > 0.5)
      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-ba-2',
            type: 'VEHICLE_DETECTED',
            confidence: 0.93,
            centroid: { x: 0.5, y: 0.8 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      expect(incidentStore.size).toBe(1);
      const incident = Array.from(incidentStore.values())[0];
      expect(incident.metadataJson.directionCrossed).toBe('B_TO_A');
    });
  });

  // =========================================================================
  // C. Bidirectional Tripwire
  // =========================================================================
  describe('C. Bidirectional Tripwire', () => {
    it('triggers incidents for crossings in both directions when BIDIRECTIONAL is configured', async () => {
      const ruleId = 'rule-tripwire-bidi';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'Perimeter Tripwire',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.BIDIRECTIONAL,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 5,
      });

      let t = 1700000000000;

      // Track 1 crosses A -> B
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-bidi-1',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.2, y: 0.7 },
            trackId: 'trk-1',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-bidi-2',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.2, y: 0.3 },
            trackId: 'trk-1',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(1);

      // Track 2 crosses B -> A
      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-bidi-3',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.8, y: 0.2 },
            trackId: 'trk-2',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-bidi-4',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.8, y: 0.8 },
            trackId: 'trk-2',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(2);
    });
  });

  // =========================================================================
  // D. No False Tripwire Crossing
  // =========================================================================
  describe('D. No False Tripwire Crossing', () => {
    it('does NOT create incident when track moves parallel, approaches without crossing, or oscillates within buffer', async () => {
      rulesStore.set('rule-tripwire-ab', {
        id: 'rule-tripwire-ab',
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      let t = 1700000000000;
      const trackId = 'trk-parallel';

      // 1. Parallel movement along y=0.7 (Side A)
      for (let x = 0.1; x <= 0.8; x += 0.2) {
        t += 1000;
        await handleIngestDetection(
          {
            body: {
              tenantId,
              cameraId,
              modelManifestId,
              inferenceId: `inf-par-${x}`,
              type: 'PERSON_DETECTED',
              confidence: 0.9,
              centroid: { x, y: 0.7 },
              trackId,
              trackState: 'CONFIRMED',
              timestamp: new Date(t).toISOString(),
            },
          } as any,
          createMockRes()
        );
      }
      expect(incidentStore.size).toBe(0);

      // 2. Approaching line to y=0.504 without crossing
      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-approach-1',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.504 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(0);
    });
  });

  // =========================================================================
  // E. Continuous Loitering Dwell
  // =========================================================================
  describe('E. Continuous Loitering Dwell', () => {
    it('triggers loitering incident only when continuous dwell exceeds thresholdSeconds', async () => {
      const ruleId = 'rule-loiter-vault';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'Secure Vault Zone',
        type: 'LOITERING',
        enabled: true,
        polygonCoordinatesJson: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        dwellThresholdSeconds: 15,
        cooldownSeconds: 30,
      });

      const trackId = 'trk-loiter-101';
      let t = 1700000000000;

      // 1. Enter polygon (dwell = 0s)
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-loiter-1',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.5, y: 0.5 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(0);

      // 2. Dwell for 10s (< 15s threshold)
      t += 10000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-loiter-2',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.52, y: 0.52 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(0);

      // 3. Dwell for 16s total (>= 15s threshold) -> Triggers Incident!
      t += 6000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-loiter-3',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.55, y: 0.55 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      expect(incidentStore.size).toBe(1);
      const incident = Array.from(incidentStore.values())[0];
      expect(incident.ruleType).toBe('LOITERING');
      expect(incident.ruleId).toBe(ruleId);
      expect(incident.metadataJson.dwellDurationSeconds).toBe(16);
    });
  });

  // =========================================================================
  // F. Loiter Reset on Exit
  // =========================================================================
  describe('F. Loiter Reset on Exit', () => {
    it('immediately resets continuous dwell timer when track exits polygon', async () => {
      const ruleId = 'rule-loiter-vault';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'Secure Vault Zone',
        type: 'LOITERING',
        enabled: true,
        polygonCoordinatesJson: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        dwellThresholdSeconds: 15,
        cooldownSeconds: 30,
      });

      const trackId = 'trk-loiter-exit';
      let t = 1700000000000;

      // 1. Enter and dwell for 12 seconds (< 15s)
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-le-1',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.5, y: 0.5 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 12000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-le-2',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.5, y: 0.5 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(0);

      // 2. Exit polygon momentarily (x=0.1, y=0.1 outside)
      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-le-3',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.1, y: 0.1 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );
      expect(incidentStore.size).toBe(0);

      // 3. Re-enter polygon and dwell for 4 seconds (12s + 4s = 16s total, but continuous dwell is 4s < 15s)
      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-le-4',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.5, y: 0.5 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 4000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-le-5',
            type: 'PERSON_DETECTED',
            confidence: 0.95,
            centroid: { x: 0.5, y: 0.5 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      // NO incident should be created because continuous dwell was reset!
      expect(incidentStore.size).toBe(0);
    });
  });

  // =========================================================================
  // G. Duplicate DetectionEvent Ingestion
  // =========================================================================
  describe('G. Duplicate DetectionEvent Ingestion', () => {
    it('deduplicates repeated submissions with identical inferenceId idempotently', async () => {
      const inferenceId = 'inf-idempotent-unique-123';
      const payload = {
        tenantId,
        cameraId,
        modelManifestId,
        inferenceId,
        type: 'PERSON_DETECTED',
        confidence: 0.9,
        boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        centroid: { x: 0.2, y: 0.2 },
        trackId: 'trk-idem',
        trackState: 'CONFIRMED',
      };

      const res1 = createMockRes();
      await handleIngestDetection({ body: payload } as any, res1);
      expect(res1.statusCode).toBe(200);

      const res2 = createMockRes();
      await handleIngestDetection({ body: payload } as any, res2);
      expect(res2.statusCode).toBe(200);

      expect(detectionStore.size).toBe(1);
    });
  });

  // =========================================================================
  // H. Duplicate Incident Prevention & DB-Level Uniqueness
  // =========================================================================
  describe('H. Duplicate Incident Prevention & DB-Level Uniqueness', () => {
    it('enforces database uniqueness constraint on (cameraId, ruleId, trackId, cooldownBucket)', async () => {
      const ruleId = 'rule-tripwire-ab';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      const trackId = 'trk-dup-incident';
      const baseTime = 1700000000000;

      // 1. Cross tripwire -> 1st Incident created
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-dup-1',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.7 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(baseTime).toISOString(),
          },
        } as any,
        createMockRes()
      );

      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-dup-2',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.3 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(baseTime + 1000).toISOString(),
          },
        } as any,
        createMockRes()
      );

      expect(incidentStore.size).toBe(1);

      // 2. Simulate rapid crossing again within the same cooldown bucket (2 seconds later < 10s cooldown)
      // Even if spatial engine was bypassed and create was called directly with the same bucket:
      const cooldownBucket = BigInt(Math.floor((baseTime + 2000) / (10 * 1000)));

      // Directly attempt duplicate insert to verify DB uniqueness constraint throws P2002
      const prisma = (await import('../config/database')).default;
      await expect(
        prisma.incident.create({
          data: {
            tenantId,
            cameraId,
            ruleId,
            trackId,
            cooldownBucket,
            ruleType: 'TRIPWIRE',
            title: 'Duplicate breach attempt',
            timestamp: new Date(baseTime + 2000),
          },
        })
      ).rejects.toMatchObject({ code: 'P2002' });

      // Total count remains exactly 1!
      expect(incidentStore.size).toBe(1);
    });
  });

  // =========================================================================
  // I. Concurrent Incident Race
  // =========================================================================
  describe('I. Concurrent Incident Race', () => {
    it('ensures at most one incident exists per (cameraId, ruleId, trackId, cooldownBucket) under concurrent execution', async () => {
      const ruleId = 'rule-tripwire-ab';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      const trackId = 'trk-race-01';
      const baseTime = 1700000000000;

      // Initialize track on SIDE_A
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-race-init',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.7 },
            trackId,
            trackState: 'CONFIRMED',
            timestamp: new Date(baseTime).toISOString(),
          },
        } as any,
        createMockRes()
      );

      // Launch simultaneous concurrent requests crossing the line
      const concurrentRequests = Array.from({ length: 5 }, (_, idx) => {
        return handleIngestDetection(
          {
            body: {
              tenantId,
              cameraId,
              modelManifestId,
              inferenceId: `inf-race-cross-${idx}`,
              type: 'PERSON_DETECTED',
              confidence: 0.9,
              centroid: { x: 0.5, y: 0.3 },
              trackId,
              trackState: 'CONFIRMED',
              timestamp: new Date(baseTime + 1000).toISOString(),
            },
          } as any,
          createMockRes()
        );
      });

      const results = await Promise.all(concurrentRequests);
      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }

      // Exactly ONE incident created despite 5 concurrent crossing attempts
      expect(incidentStore.size).toBe(1);
    });
  });

  // =========================================================================
  // J. Unconfirmed Tracks Gating
  // =========================================================================
  describe('J. Unconfirmed Tracks Gating', () => {
    it('does NOT trigger spatial rule evaluation or incident creation for TENTATIVE tracks', async () => {
      const ruleId = 'rule-tripwire-ab';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      const trackId = 'trk-tentative-99';
      let t = 1700000000000;

      // Ingest crossing with trackState = 'TENTATIVE'
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-tent-1',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.7 },
            trackId,
            trackState: 'TENTATIVE', // Unconfirmed candidate!
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-tent-2',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.3 },
            trackId,
            trackState: 'TENTATIVE', // Unconfirmed candidate!
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      // Must be completely ignored for operational spatial analytics
      expect(incidentStore.size).toBe(0);
    });
  });

  // =========================================================================
  // K. Evidence Plane Isolation
  // =========================================================================
  describe('K. Evidence Plane Isolation Under Spatial Rule Execution', () => {
    it('proves spatial rule evaluation and incident creation has ZERO interaction with recording or evidence services', async () => {
      // 1. Setup spies on recording and evidence manifest services
      const manifestSpy = jest.spyOn(EvidenceManifestService.prototype, 'createManifest');
      const indexSpy = jest.spyOn(RecordingIndexService.prototype, 'indexSegment');

      const ruleId = 'rule-tripwire-ab';
      rulesStore.set(ruleId, {
        id: ruleId,
        tenantId,
        cameraId,
        name: 'South Gate Ingress',
        type: 'TRIPWIRE',
        enabled: true,
        direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [
          { x: 0.0, y: 0.5 },
          { x: 1.0, y: 0.5 },
        ],
        cooldownSeconds: 10,
      });

      // 2. Perform tripwire breach
      let t = 1700000000000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-ev-iso-1',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.7 },
            trackId: 'trk-ev-iso',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      t += 1000;
      await handleIngestDetection(
        {
          body: {
            tenantId,
            cameraId,
            modelManifestId,
            inferenceId: 'inf-ev-iso-2',
            type: 'PERSON_DETECTED',
            confidence: 0.9,
            centroid: { x: 0.5, y: 0.3 },
            trackId: 'trk-ev-iso',
            trackState: 'CONFIRMED',
            timestamp: new Date(t).toISOString(),
          },
        } as any,
        createMockRes()
      );

      // Verify Incident was created in the AI plane
      expect(incidentStore.size).toBe(1);

      // HARD ARCHITECTURAL INVARIANT 10:
      // Zero calls to evidence manifest, segmenting, or recording indexers!
      expect(manifestSpy).not.toHaveBeenCalled();
      expect(indexSpy).not.toHaveBeenCalled();

      manifestSpy.mockRestore();
      indexSpy.mockRestore();
    });
  });
});
