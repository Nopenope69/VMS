import { PrismaClient, EventType } from '@prisma/client';
import {
  ModelManifestService,
  CreateModelManifestInput,
  APPROVED_BASELINE_LICENSES,
  REVIEWED_EXCEPTION_LICENSES,
} from '../services/ai/modelManifest.service';

let modelManifestStore: any[] = [];
let detectionEventStore: any[] = [];
let cameraStore: any[] = [];

const mockPrisma: any = {
  modelManifest: {
    create: jest.fn().mockImplementation(({ data }) => {
      const exists = modelManifestStore.find(
        (m) => m.name === data.name && m.version === data.version
      );
      if (exists) {
        const err: any = new Error('Unique constraint failed on (name, version)');
        err.code = 'P2002';
        return Promise.reject(err);
      }
      const record = {
        id: `manifest-${modelManifestStore.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      modelManifestStore.push(record);
      return Promise.resolve(record);
    }),
    findUnique: jest.fn().mockImplementation(({ where }) => {
      if (where.id) {
        return Promise.resolve(modelManifestStore.find((m) => m.id === where.id) || null);
      }
      if (where.name_version) {
        return Promise.resolve(
          modelManifestStore.find(
            (m) => m.name === where.name_version.name && m.version === where.name_version.version
          ) || null
        );
      }
      return Promise.resolve(null);
    }),
    findFirst: jest.fn().mockImplementation(({ where }) => {
      const found = modelManifestStore.find((m) => {
        if (where.name && m.name !== where.name) return false;
        if (where.version && m.version !== where.version) return false;
        if (where.isActive !== undefined && m.isActive !== where.isActive) return false;
        return true;
      });
      return Promise.resolve(found || null);
    }),
    findMany: jest.fn().mockImplementation(({ where } = {}) => {
      if (!where) return Promise.resolve([...modelManifestStore]);
      return Promise.resolve(
        modelManifestStore.filter((m) => {
          if (where.isActive !== undefined && m.isActive !== where.isActive) return false;
          return true;
        })
      );
    }),
  },
  camera: {
    findFirst: jest.fn().mockImplementation(({ where }) => {
      const found = cameraStore.find((c) => {
        if (where.tenantId && c.tenantId !== where.tenantId) return false;
        if (where.OR) {
          const matchesOr = where.OR.some((clause: any) => {
            if (clause.id && c.id === clause.id) return true;
            if (clause.streamPath && c.streamPath === clause.streamPath) return true;
            return false;
          });
          if (!matchesOr) return false;
        }
        if (where.id && c.id !== where.id) return false;
        return true;
      });
      return Promise.resolve(found || null);
    }),
  },
  detectionEvent: {
    create: jest.fn().mockImplementation(({ data }) => {
      if (data.inferenceId && detectionEventStore.some((d) => d.inferenceId === data.inferenceId)) {
        const err: any = new Error('Unique constraint failed on inferenceId');
        err.code = 'P2002';
        return Promise.reject(err);
      }
      const record = { id: `det-${detectionEventStore.length + 1}`, ...data };
      detectionEventStore.push(record);
      return Promise.resolve(record);
    }),
    upsert: jest.fn().mockImplementation(async ({ where, create }) => {
      const existing = detectionEventStore.find((d) => d.inferenceId === where.inferenceId);
      if (existing) {
        return existing;
      }
      const record = { id: `det-${detectionEventStore.length + 1}`, ...create };
      detectionEventStore.push(record);
      return record;
    }),
    findUnique: jest.fn().mockImplementation(({ where }) => {
      if (where.id) return Promise.resolve(detectionEventStore.find((d) => d.id === where.id) || null);
      if (where.inferenceId) {
        return Promise.resolve(detectionEventStore.find((d) => d.inferenceId === where.inferenceId) || null);
      }
      return Promise.resolve(null);
    }),
  },
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: mockPrisma,
}));


describe('Governed AI Foundation: ModelManifest & Detection Ingestion', () => {
  let service: ModelManifestService;

  const validSampleModel: CreateModelManifestInput = {
    name: 'vigilone-yolo-edge',
    version: '1.0.0',
    sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    codeLicense: 'Apache-2.0',
    weightLicense: 'Apache-2.0',
    trainingData: {
      source: 'COCO-2017-Subsampled',
      license: 'CC-BY-4.0',
      provenance: 'public-dataset',
      commercialUse: true,
    },
    thresholds: {
      person: 0.45,
      car: 0.5,
    },
    runtimeConfig: {
      runtime: 'onnxruntime',
      runtimeVersion: '1.17.0',
      executionProvider: 'CPUExecutionProvider',
      inputWidth: 640,
      inputHeight: 640,
      colorSpace: 'RGB',
      normalization: {
        type: 'scale',
        value: 255.0,
      },
      letterbox: true,
      modelFormat: 'ONNX',
    },
    attributionRequired: true,
    noticeRequired: true,
    licenseNotes: 'Preserve Apache-2.0 copyright notices.',
    isActive: true,
  };

  beforeEach(() => {
    modelManifestStore = [];
    detectionEventStore = [];
    cameraStore = [
      { id: 'cam-01', tenantId: 'tenant-alpha', streamPath: 'cam-01-main', name: 'Main Gate' },
      { id: 'cam-02', tenantId: 'tenant-beta', streamPath: 'cam-02-main', name: 'Vault Entrance' },
    ];
    service = new ModelManifestService(mockPrisma as PrismaClient);
  });

  describe('1. Commercial License Policy & SPDX Normalization', () => {
    it('approves all baseline commercial licenses (MIT, Apache-2.0, BSD-2/3, ISC)', () => {
      for (const lic of APPROVED_BASELINE_LICENSES) {
        const res = service.evaluateLicensePolicy(lic);
        expect(res.approved).toBe(true);
        expect(res.isException).toBe(false);
      }
    });

    it('approves MPL-2.0 strictly as a reviewed file-level copyleft exception', () => {
      for (const lic of REVIEWED_EXCEPTION_LICENSES) {
        const res = service.evaluateLicensePolicy(lic);
        expect(res.approved).toBe(true);
        expect(res.isException).toBe(true);
        expect(res.reason).toContain('reviewed file-level copyleft exception');
      }
    });

    it('rejects copyleft licenses (GPL, AGPL) by default', () => {
      const copyleft = ['GPL', 'GPL-2.0', 'GPL-3.0', 'AGPL', 'AGPL-3.0', 'LGPL-3.0'];
      for (const lic of copyleft) {
        const res = service.evaluateLicensePolicy(lic);
        expect(res.approved).toBe(false);
        expect(res.reason).toContain('rejected under VigilOne policy');
      }
    });

    it('rejects non-commercial licenses (CC-BY-NC) and proprietary/unknown licenses', () => {
      expect(service.evaluateLicensePolicy('CC-BY-NC-4.0').approved).toBe(false);
      expect(service.evaluateLicensePolicy('PROPRIETARY').approved).toBe(false);
      expect(service.evaluateLicensePolicy('Random-Unknown-123').approved).toBe(false);
      expect(service.evaluateLicensePolicy('').approved).toBe(false);
    });

    it('normalizes non-canonical license strings to standard SPDX identifiers', () => {
      expect(service.normalizeSpdx('apache 2.0')).toBe('Apache-2.0');
      expect(service.normalizeSpdx('mit')).toBe('MIT');
      expect(service.normalizeSpdx('bsd 3-clause')).toBe('BSD-3-Clause');
      expect(service.normalizeSpdx('bsd-2-clause')).toBe('BSD-2-Clause');
      expect(service.normalizeSpdx('mpl 2.0')).toBe('MPL-2.0');
    });

    it('infers attribution and legal notice obligations based on license', () => {
      const apache = service.inferLicenseObligations('Apache-2.0');
      expect(apache.attributionRequired).toBe(true);
      expect(apache.noticeRequired).toBe(true);

      const mit = service.inferLicenseObligations('MIT');
      expect(mit.attributionRequired).toBe(true);
      expect(mit.noticeRequired).toBe(false);
    });
  });

  describe('2. Model Manifest Validation Rules', () => {
    it('accepts a fully compliant manifest with approved code and weight licenses', () => {
      const val = service.validateModelManifest(validSampleModel);
      expect(val.valid).toBe(true);
      expect(val.errors).toHaveLength(0);
    });

    it('fails validation when code license is copyleft even if weights are permissive', () => {
      const val = service.validateModelManifest({
        ...validSampleModel,
        codeLicense: 'GPL-3.0',
      });
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('codeLicense error'))).toBe(true);
    });

    it('fails validation when weight license is copyleft even if code is permissive', () => {
      const val = service.validateModelManifest({
        ...validSampleModel,
        weightLicense: 'AGPL-3.0',
      });
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('weightLicense error'))).toBe(true);
    });

    it('fails validation on invalid or missing SHA-256 artifact hash', () => {
      const notHex = service.validateModelManifest({ ...validSampleModel, sha256: 'not-a-valid-sha256' });
      expect(notHex.valid).toBe(false);
      expect(notHex.errors.some((e) => e.includes('sha256 must be a valid 64-character'))).toBe(true);

      const tooShort = service.validateModelManifest({ ...validSampleModel, sha256: 'abcdef1234' });
      expect(tooShort.valid).toBe(false);
    });

    it('validates training data provenance and strictly rejects non-commercial / unknown datasets', () => {
      const nonComm = service.validateModelManifest({
        ...validSampleModel,
        trainingData: {
          source: 'Academic-Set',
          license: 'CC-BY-NC',
          provenance: 'academic',
          commercialUse: false,
        },
      });
      expect(nonComm.valid).toBe(false);
      expect(nonComm.errors.some((e) => e.includes('prohibits commercial use') || e.includes('explicitly true'))).toBe(true);

      const unknownProv = service.validateModelManifest({
        ...validSampleModel,
        trainingData: {
          source: 'Scraped-Web',
          license: 'CC0',
          provenance: 'unknown',
          commercialUse: true,
        },
      });
      expect(unknownProv.valid).toBe(false);
      expect(unknownProv.errors.some((e) => e.includes('cannot be "unknown"'))).toBe(true);
    });

    it('validates runtime and preprocessing configuration pinning', () => {
      const missingRuntime = service.validateModelManifest({
        ...validSampleModel,
        runtimeConfig: { ...validSampleModel.runtimeConfig, runtime: '' },
      });
      expect(missingRuntime.valid).toBe(false);

      const badDims = service.validateModelManifest({
        ...validSampleModel,
        runtimeConfig: { ...validSampleModel.runtimeConfig, inputWidth: -1 },
      });
      expect(badDims.valid).toBe(false);
    });
  });

  describe('3. Registration, Lookup & Immutability Guarantees', () => {
    it('registers a valid model manifest successfully', async () => {
      const manifest = await service.registerModelManifest(validSampleModel);
      expect(manifest.id).toBeDefined();
      expect(manifest.name).toBe(validSampleModel.name);
      expect(manifest.version).toBe(validSampleModel.version);
      expect(modelManifestStore).toHaveLength(1);
    });

    it('allows idempotent re-registration of exact same model version with identical SHA-256', async () => {
      const m1 = await service.registerModelManifest(validSampleModel);
      const m2 = await service.registerModelManifest(validSampleModel);
      expect(m1.id).toBe(m2.id);
      expect(modelManifestStore).toHaveLength(1);
    });

    it('strictly forbids mutating existing model version with a different artifact SHA-256', async () => {
      await service.registerModelManifest(validSampleModel);

      const modifiedArtifact = {
        ...validSampleModel,
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };

      await expect(service.registerModelManifest(modifiedArtifact)).rejects.toThrow(
        /Model version immutability violation/
      );
    });

    it('looks up registered manifests by id and by active name/version', async () => {
      const registered = await service.registerModelManifest(validSampleModel);
      const byId = await service.getModelManifest(registered.id);
      expect(byId?.id).toBe(registered.id);

      const active = await service.getActiveModelManifest(validSampleModel.name, validSampleModel.version);
      expect(active?.id).toBe(registered.id);
    });

    it('returns null when querying an inactive model via getActiveModelManifest', async () => {
      const inactive = await service.registerModelManifest({
        ...validSampleModel,
        name: 'retired-model',
        version: '0.9.0',
        isActive: false,
      });
      expect(inactive.isActive).toBe(false);

      const lookup = await service.getActiveModelManifest('retired-model', '0.9.0');
      expect(lookup).toBeNull();
    });
  });

  // Section 4 (detection ingestion through the route with an in-memory database) moved to
  // aiPipelineRealDb.test.ts, which runs the same cases against the real database.
});
