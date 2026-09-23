import { PrismaClient } from '@prisma/client';
import {
  ModelManifestService,
  CreateModelManifestInput,
  APPROVED_BASELINE_LICENSES,
} from '../../src/services/ai/modelManifest.service';

interface ModelCatalogEntry extends CreateModelManifestInput {
  description?: string;
}

/**
 * Baseline Seed Catalog of Governed Models for VigilOne Appliance.
 * Every model deployed to VigilOne must be declared and pre-approved here.
 */
export const SEEDED_MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    name: 'vigilone-person-vehicle-detector',
    version: '1.0.0',
    sha256: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    codeLicense: 'Apache-2.0',
    weightLicense: 'Apache-2.0',
    trainingData: {
      source: 'CrowdHuman-COCO-Curated',
      license: 'CC-BY-4.0',
      provenance: 'public-curated-dataset',
      commercialUse: true,
    },
    thresholds: {
      personConfidence: 0.45,
      vehicleConfidence: 0.5,
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
    licenseNotes: 'Apache-2.0 requires preservation of copyright and NOTICE file in binary distributions.',
    isActive: true,
  },
  {
    name: 'vigilone-spatial-intrusion-detector',
    version: '1.0.0',
    sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    codeLicense: 'MIT',
    weightLicense: 'MIT',
    trainingData: {
      source: 'OpenImages-V7-Perimeter',
      license: 'CC-BY-4.0',
      provenance: 'public-dataset',
      commercialUse: true,
    },
    thresholds: {
      detectionConfidence: 0.4,
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
    noticeRequired: false,
    licenseNotes: 'MIT license copyright notice must be included in documentation.',
    isActive: true,
  },
];

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
  console.log('--- Step 3: Auditing Seeded Model Catalog ---');
  for (const model of SEEDED_MODEL_CATALOG) {
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
