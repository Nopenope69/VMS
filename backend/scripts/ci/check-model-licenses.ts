import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  ModelManifestService,
  CreateModelManifestInput,
  APPROVED_BASELINE_LICENSES,
} from '../../src/services/ai/modelManifest.service';

interface ModelCatalogEntry extends CreateModelManifestInput {
  key: string;
  url: string;
}

/** scripts/models/models.lock.json: the pinned models an appliance may run (P2.3). */
export const MODEL_LOCK_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'models', 'models.lock.json');

/**
 * Governed model catalog, read from the lock file (the single source of truth shared with
 * scripts/models/fetch-model.sh and the ai-worker). Every hash here is the SHA-256 of a real,
 * downloadable artefact; there are no placeholder models.
 */
export function loadModelCatalog(lockPath: string = MODEL_LOCK_PATH): ModelCatalogEntry[] {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return (lock.models as any[]).map((m) => ({
    key: m.key,
    url: m.url,
    name: m.name,
    version: m.version,
    sha256: m.sha256,
    codeLicense: m.codeLicense,
    weightLicense: m.weightLicense,
    trainingData: m.trainingData,
    thresholds: m.thresholds,
    runtimeConfig: m.runtimeConfig,
    attributionRequired: m.attributionRequired,
    noticeRequired: m.noticeRequired,
    licenseNotes: m.licenseNotes,
    isActive: true,
    task: m.task,
    weightsSource: m.weightsSource,
    modelSignature: m.modelSignature,
    classes: m.classes,
    nmsConfig: m.nmsConfig,
  }));
}

export const SEEDED_MODEL_CATALOG: ModelCatalogEntry[] = loadModelCatalog();

export async function runModelLicenseGate(): Promise<boolean> {
  console.log('🛡️  Running VigilOne Pre-Deployment Model License & Governance CI Gate...\n');

  const mockPrisma = {} as PrismaClient;
  const service = new ModelManifestService(mockPrisma);
  let failed = false;

  // -------------------------------------------------------------
  // Test 1: Self-test of license policy engine
  // -------------------------------------------------------------
  console.log('--- Step 1: Validating Commercial License Policy Rules ---');

  // Approved baseline licenses must pass
  for (const lic of APPROVED_BASELINE_LICENSES) {
    const evalResult = service.evaluateLicensePolicy(lic);
    if (!evalResult.approved) {
      console.error(`❌ Baseline approved license '${lic}' failed policy evaluation: ${evalResult.reason}`);
      failed = true;
    }
  }

  // Copyleft licenses must be rejected
  const copyleftToTest = ['GPL-3.0', 'GPL-2.0', 'AGPL-3.0', 'CC-BY-NC'];
  for (const lic of copyleftToTest) {
    const evalResult = service.evaluateLicensePolicy(lic);
    if (evalResult.approved) {
      console.error(`❌ Prohibited license '${lic}' was unexpectedly approved!`);
      failed = true;
    }
  }

  // Missing or unknown licenses must be rejected
  const unknownToTest = ['', 'Custom-Commercial-Proprietary', 'UNKNOWN-XYZ'];
  for (const lic of unknownToTest) {
    const evalResult = service.evaluateLicensePolicy(lic);
    if (evalResult.approved) {
      console.error(`❌ Unknown/missing license '${lic}' was unexpectedly approved!`);
      failed = true;
    }
  }

  // Reviewed exception MPL-2.0 must pass as exception
  const mplEval = service.evaluateLicensePolicy('MPL-2.0');
  if (!mplEval.approved || !mplEval.isException) {
    console.error('❌ MPL-2.0 was not correctly evaluated as a reviewed exception.');
    failed = true;
  }

  console.log('✅ License policy evaluation rules verified cleanly.\n');

  // -------------------------------------------------------------
  // Test 2: Negative regression tests for manifest validation
  // -------------------------------------------------------------
  console.log('--- Step 2: Testing Manifest Governance Boundary Conditions ---');

  const baseValidModel: CreateModelManifestInput = {
    name: 'test-model',
    version: '1.0.0',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    codeLicense: 'MIT',
    weightLicense: 'Apache-2.0',
    trainingData: {
      source: 'Test-Data',
      license: 'CC-BY-4.0',
      provenance: 'public-dataset',
      commercialUse: true,
    },
    runtimeConfig: {
      runtime: 'onnxruntime',
      modelFormat: 'ONNX',
      inputWidth: 640,
      inputHeight: 640,
      colorSpace: 'RGB',
    },
  };

  // Case A: Unacceptable weight license
  const invalidWeights = { ...baseValidModel, weightLicense: 'GPL-3.0' };
  const resWeights = service.validateModelManifest(invalidWeights);
  if (resWeights.valid) {
    console.error('❌ Copyleft weight license was unexpectedly approved!');
    failed = true;
  }

  // Case B: Non-commercial training data provenance
  const nonCommercialData: CreateModelManifestInput = {
    ...baseValidModel,
    trainingData: {
      source: 'Academic-Only',
      license: 'CC-BY-NC-4.0',
      provenance: 'academic-research',
      commercialUse: false,
    },
  };
  const resData = service.validateModelManifest(nonCommercialData);
  if (resData.valid) {
    console.error('❌ Non-commercial training data provenance was unexpectedly approved!');
    failed = true;
  }

  // Case C: Unknown training provenance
  const unknownProvenance: CreateModelManifestInput = {
    ...baseValidModel,
    trainingData: {
      source: 'Internet',
      license: 'CC-BY-4.0',
      provenance: 'unknown',
      commercialUse: true,
    },
  };
  const resUnknown = service.validateModelManifest(unknownProvenance);
  if (resUnknown.valid) {
    console.error('❌ Unknown training data provenance was unexpectedly approved!');
    failed = true;
  }

  console.log('✅ Boundary validation regressions verified cleanly.\n');

  // -------------------------------------------------------------
  // Test 3: Validate Seeded Model Catalog
  // -------------------------------------------------------------
  console.log('--- Step 3: Auditing Pinned Model Catalog (scripts/models/models.lock.json) ---');
  if (SEEDED_MODEL_CATALOG.length === 0) {
    console.error('❌ The model lock file lists no models.');
    failed = true;
  }
  for (const model of SEEDED_MODEL_CATALOG) {
    if (!/^https:\/\//.test(model.url)) {
      console.error(`❌ ${model.key}: artefact URL must be https (got '${model.url}')`);
      failed = true;
    }
    if (!model.weightsSource || !model.modelSignature) {
      console.error(`❌ ${model.key}: weightsSource and modelSignature are required for provenance and decoding`);
      failed = true;
    }
    const valResult = service.validateModelManifest(model);
    if (!valResult.valid) {
      console.error(`❌ Seeded model '${model.name}:${model.version}' failed validation:`);
      for (const err of valResult.errors) {
        console.error(`     - ${err}`);
      }
      failed = true;
    } else {
      console.log(`  ✓ ${model.name}:${model.version} (Code: ${model.codeLicense}, Weights: ${model.weightLicense})`);
    }
  }

  // -------------------------------------------------------------
  // Test 3b: Candidate models (training-data licence pending human review)
  // -------------------------------------------------------------
  console.log('\n--- Step 3b: Auditing candidate models (not runnable without a human approval) ---');
  const lock = JSON.parse(fs.readFileSync(MODEL_LOCK_PATH, 'utf8'));
  const candidates: any[] = lock.candidateModels || [];
  const exceptionsPath = path.join(path.dirname(MODEL_LOCK_PATH), 'model-license-exceptions.json');
  const approvals: any[] = fs.existsSync(exceptionsPath) ? JSON.parse(fs.readFileSync(exceptionsPath, 'utf8')).approvals || [] : [];
  for (const c of candidates) {
    for (const [kind, lic] of [['code', c.codeLicense], ['weight', c.weightLicense]] as const) {
      const ev = service.evaluateLicensePolicy(lic);
      if (!ev.approved) {
        console.error(`❌ candidate ${c.key}: ${kind} licence '${lic}' is not allowed (${ev.reason})`);
        failed = true;
      }
    }
    if (!/^[a-f0-9]{64}$/.test(c.sha256 || '') || !/^https:\/\//.test(c.url || '')) {
      console.error(`❌ candidate ${c.key}: https URL and SHA-256 are required`);
      failed = true;
    }
    if (c.governance?.status !== 'PENDING_HUMAN_REVIEW' || !c.governance?.question) {
      console.error(`❌ candidate ${c.key}: governance.status PENDING_HUMAN_REVIEW and the open question are required`);
      failed = true;
    }
    const approved = approvals.find((a) => a.key === c.key && a.sha256 === c.sha256);
    console.log(`  ${approved ? '✓ APPROVED by ' + approved.approvedBy : '⏸ pending human review'}: ${c.key} (weights ${c.weightLicense}) - ${c.governance?.question}`);
  }
  for (const a of approvals) {
    const c = candidates.find((x) => x.key === a.key);
    if (!c || c.sha256 !== a.sha256 || !a.approvedBy || !a.approvedAt || !a.reason) {
      console.error(`❌ model-license-exceptions.json: approval for '${a.key}' does not match a candidate model's SHA-256 or lacks approver/date/reason`);
      failed = true;
    }
  }

  // -------------------------------------------------------------
  // Test 4: Audit Database registered models if database is reachable
  // -------------------------------------------------------------
  try {
    const realPrisma = new PrismaClient();
    const dbModels = await realPrisma.modelManifest.findMany();
    if (dbModels.length > 0) {
      console.log(`\n--- Step 4: Auditing ${dbModels.length} Models from Database ---`);
      for (const dbm of dbModels) {
        const valResult = service.validateModelManifest({
          name: dbm.name,
          version: dbm.version,
          sha256: dbm.sha256,
          codeLicense: dbm.codeLicense,
          weightLicense: dbm.weightLicense,
          trainingData: dbm.trainingDataJson as any,
          runtimeConfig: dbm.runtimeConfigJson as any,
          attributionRequired: dbm.attributionRequired,
          noticeRequired: dbm.noticeRequired,
          licenseNotes: dbm.licenseNotes ?? undefined,
          isActive: dbm.isActive,
        });

        if (!valResult.valid) {
          console.error(`❌ Database model '${dbm.name}:${dbm.version}' (id: ${dbm.id}) violates license policy:`);
          for (const err of valResult.errors) {
            console.error(`     - ${err}`);
          }
          failed = true;
        } else {
          console.log(`  ✓ DB: ${dbm.name}:${dbm.version} [VALID]`);
        }
      }
    }
    await realPrisma.$disconnect();
  } catch {
    // Database may be offline during pure offline CI checks; seeded catalog audit is primary
  }

  if (failed) {
    console.error('\n🚨 MODEL LICENSE GATE FAILED. One or more models violate commercial licensing policy.\n');
    return false;
  }

  console.log('\n🎉 ALL MODEL LICENSES AND PROVENANCE INVARIANTS SATISFIED.\n');
  return true;
}

if (require.main === module) {
  runModelLicenseGate()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal error during model license check:', err);
      process.exit(1);
    });
}
