import { ModelManifest, PrismaClient } from '@prisma/client';

export interface TrainingDataProvenance {
  source: string;
  license: string;
  provenance: string;
  commercialUse: boolean;
}

export interface RuntimeConfig {
  runtime: string;
  runtimeVersion?: string;
  executionProvider?: string;
  executionProviderVersion?: string;
  inputWidth: number;
  inputHeight: number;
  colorSpace: 'RGB' | 'BGR' | 'GRAY' | string;
  normalization?: {
    type: string;
    value?: number | number[];
    mean?: number[];
    std?: number[];
  };
  letterbox?: boolean;
  modelFormat: string;
}

export interface CreateModelManifestInput {
  name: string;
  version: string;
  sha256: string;
  codeLicense: string;
  weightLicense: string;
  trainingData: TrainingDataProvenance;
  thresholds?: Record<string, number>;
  runtimeConfig: RuntimeConfig;
  attributionRequired?: boolean;
  noticeRequired?: boolean;
  licenseNotes?: string;
  isActive?: boolean;
  /** Phase 2 fields: decoding contract and weights provenance (optional for legacy callers). */
  task?: string;
  weightsSource?: string;
  modelSignature?: Record<string, unknown>;
  classes?: Record<string, string>;
  nmsConfig?: Record<string, unknown>;
}

/** Human approvals for candidate models; see scripts/models/model-license-exceptions.json. */
export function readModelLicenseApprovals(): Array<{ key: string; sha256: string; approvedBy: string; approvedAt: string; reason: string }> {
  const candidates = [
    process.env.VIGILONE_MODEL_EXCEPTIONS,
    '/etc/vigilone/model-license-exceptions.json',
    require('path').resolve(__dirname, '../../../../scripts/models/model-license-exceptions.json'),
  ].filter(Boolean) as string[];
  const fs = require('fs');
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(j.approvals) ? j.approvals : []).filter(
      (a: any) => a && typeof a.key === 'string' && /^[a-f0-9]{64}$/.test(a.sha256) && a.approvedBy && a.approvedAt && a.reason
    );
  } catch {
    return [];
  }
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Baseline commercially approved licenses:
 * Permissive licenses suitable for proprietary integration without copyleft contagion.
 */
export const APPROVED_BASELINE_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
] as const;

/**
 * Reviewed exceptions:
 * MPL-2.0 is a file-level (weak) copyleft license. It is permitted only as an explicitly
 * reviewed exception because it does not infect proprietary modules that merely link or invoke it,
 * but modifications to MPL-covered files must remain available under MPL-2.0.
 */
export const REVIEWED_EXCEPTION_LICENSES = ['MPL-2.0'] as const;

export const REJECTED_COPYLEFT_LICENSES = [
  'GPL',
  'GPL-2.0',
  'GPL-3.0',
  'AGPL',
  'AGPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'CC-BY-NC',
  'CC-BY-NC-4.0',
  'PROPRIETARY',
  'COMMERCIAL-ONLY',
] as const;

export class ModelManifestService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Normalizes license string to standardized SPDX identifier where recognized.
   */
  public normalizeSpdx(rawLicense: string): string {
    if (!rawLicense || typeof rawLicense !== 'string') {
      return '';
    }

    const trimmed = rawLicense.trim();
    const upper = trimmed.toUpperCase().replace(/\s+/g, '-');

    if (upper === 'MIT') return 'MIT';
    if (upper === 'APACHE-2.0' || upper === 'APACHE2' || upper === 'APACHE-2') return 'Apache-2.0';
    if (upper === 'BSD-2-CLAUSE' || upper === 'BSD-2') return 'BSD-2-Clause';
    if (upper === 'BSD-3-CLAUSE' || upper === 'BSD-3') return 'BSD-3-Clause';
    if (upper === 'ISC') return 'ISC';
    if (upper === 'MPL-2.0' || upper === 'MPL-2') return 'MPL-2.0';
    if (upper.startsWith('GPL-3')) return 'GPL-3.0';
    if (upper.startsWith('GPL-2')) return 'GPL-2.0';
    if (upper.startsWith('AGPL-3')) return 'AGPL-3.0';
    if (upper.startsWith('AGPL')) return 'AGPL';
    if (upper.startsWith('CC-BY-NC')) return 'CC-BY-NC-4.0';

    return trimmed;
  }

  /**
   * Evaluates whether a license conforms to the VigilOne Commercially Approved License Policy.
   */
  public evaluateLicensePolicy(licenseName: string): {
    approved: boolean;
    isException: boolean;
    reason?: string;
  } {
    // A pipeline of models may carry "A AND B": every part must pass on its own.
    if (typeof licenseName === 'string' && licenseName.includes(' AND ')) {
      const parts = licenseName.split(' AND ').map((p) => this.evaluateLicensePolicy(p.trim()));
      const bad = parts.find((p) => !p.approved);
      if (bad) return bad;
      return { approved: true, isException: parts.some((p) => p.isException) };
    }
    const spdx = this.normalizeSpdx(licenseName);
    if (!spdx) {
      return { approved: false, isException: false, reason: 'License identifier is missing or empty' };
    }

    // Check explicit rejection
    const isCopyleftOrRestricted = REJECTED_COPYLEFT_LICENSES.some(
      (r) => spdx.toUpperCase() === r.toUpperCase() || spdx.toUpperCase().startsWith(`${r.toUpperCase()}-`)
    );
    if (isCopyleftOrRestricted) {
      return {
        approved: false,
        isException: false,
        reason: `License '${spdx}' is rejected under VigilOne policy (copyleft / non-commercial restriction).`,
      };
    }

    // Check baseline approved
    const isBaseline = (APPROVED_BASELINE_LICENSES as readonly string[]).includes(spdx);
    if (isBaseline) {
      return { approved: true, isException: false };
    }

    // Check reviewed exception
    const isException = (REVIEWED_EXCEPTION_LICENSES as readonly string[]).includes(spdx);
    if (isException) {
      return {
        approved: true,
        isException: true,
        reason: 'MPL-2.0 accepted as reviewed file-level copyleft exception.',
      };
    }

    return {
      approved: false,
      isException: false,
      reason: `License '${spdx}' is not on the commercially approved allowlist.`,
    };
  }

  /**
   * Derives default legal notice and attribution obligations from approved license types.
   */
  public inferLicenseObligations(licenseName: string): {
    attributionRequired: boolean;
    noticeRequired: boolean;
    licenseNotes: string;
  } {
    const spdx = this.normalizeSpdx(licenseName);

    switch (spdx) {
      case 'Apache-2.0':
        return {
          attributionRequired: true,
          noticeRequired: true,
          licenseNotes: 'Requires preservation of Apache-2.0 copyright notices, patent statements, and NOTICE file.',
        };
      case 'BSD-3-Clause':
        return {
          attributionRequired: true,
          noticeRequired: true,
          licenseNotes: 'Requires copyright notice preservation and prohibits endorsement using author names.',
        };
      case 'BSD-2-Clause':
        return {
          attributionRequired: true,
          noticeRequired: false,
          licenseNotes: 'Requires copyright notice and disclaimer preservation in source and binary forms.',
        };
      case 'MIT':
        return {
          attributionRequired: true,
          noticeRequired: false,
          licenseNotes: 'Requires copyright notice and permission notice preservation.',
        };
      case 'ISC':
        return {
          attributionRequired: true,
          noticeRequired: false,
          licenseNotes: 'Requires copyright notice and permission notice preservation.',
        };
      case 'MPL-2.0':
        return {
          attributionRequired: true,
          noticeRequired: true,
          licenseNotes: 'File-level copyleft exception: source code of modifications to MPL-covered files must be provided upon distribution.',
        };
      default:
        return {
          attributionRequired: false,
          noticeRequired: false,
          licenseNotes: `Unclassified obligations for ${licenseName}`,
        };
    }
  }

  /**
   * Validates a model manifest against architectural, cryptographic, and legal requirements.
   */
  public validateModelManifest(input: CreateModelManifestInput): ManifestValidationResult {
    const errors: string[] = [];

    // 1. Model Name and Version
    if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      errors.push('Model name is required');
    }
    if (!input.version || typeof input.version !== 'string' || input.version.trim().length === 0) {
      errors.push('Model version is required');
    }

    // 2. Cryptographic Artifact SHA-256
    if (!input.sha256 || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
      errors.push('sha256 must be a valid 64-character hexadecimal digest representing the model artifact');
    }

    // 3. Code License Policy
    if (!input.codeLicense) {
      errors.push('codeLicense is required');
    } else {
      const codeEval = this.evaluateLicensePolicy(input.codeLicense);
      if (!codeEval.approved) {
        errors.push(`codeLicense error: ${codeEval.reason}`);
      }
    }

    // 4. Weight License Policy
    if (!input.weightLicense) {
      errors.push('weightLicense is required');
    } else {
      const weightEval = this.evaluateLicensePolicy(input.weightLicense);
      if (!weightEval.approved) {
        errors.push(`weightLicense error: ${weightEval.reason}`);
      }
    }

    // 5. Training Data Provenance
    if (!input.trainingData || typeof input.trainingData !== 'object') {
      errors.push('trainingData provenance object is required');
    } else {
      const td = input.trainingData;
      if (!td.source || typeof td.source !== 'string' || td.source.trim().length === 0) {
        errors.push('trainingData.source is required');
      }
      if (!td.license || typeof td.license !== 'string' || td.license.trim().length === 0) {
        errors.push('trainingData.license is required');
      } else {
        const normLicense = td.license.toUpperCase();
        if (normLicense.includes('NC') || normLicense.includes('NON-COMMERCIAL')) {
          errors.push(`trainingData.license '${td.license}' prohibits commercial use`);
        }
      }
      if (!td.provenance || typeof td.provenance !== 'string' || td.provenance.trim().toLowerCase() === 'unknown') {
        errors.push('trainingData.provenance must be known and documented (cannot be "unknown")');
      }
      if (td.commercialUse !== true) {
        errors.push('trainingData.commercialUse must be explicitly true');
      }
    }

    // 5b. Pipelines of candidate models (P4.1 ANPR): the training-data declaration comes from
    // human approvals, so every component must have one for its exact SHA-256 in the approvals
    // file this backend reads. The worker's claim alone is not enough.
    const sig: any = input.modelSignature;
    if (sig && sig.decoder === 'anpr_pipeline') {
      const comps: any[] = Array.isArray(sig.components) ? sig.components : [];
      if (comps.length === 0) errors.push('pipeline manifests must list their components');
      const approvals = readModelLicenseApprovals();
      for (const c of comps) {
        if (!approvals.some((a) => a.key === c.key && a.sha256 === c.sha256)) {
          errors.push(`pipeline component '${c.key}' (${c.sha256}) has no human licence approval (model-license-exceptions.json)`);
        }
      }
    }

    // 6. Runtime and Preprocessing Configuration Pinning
    if (!input.runtimeConfig || typeof input.runtimeConfig !== 'object') {
      errors.push('runtimeConfig configuration is required');
    } else {
      const rc = input.runtimeConfig;
      if (!rc.runtime || typeof rc.runtime !== 'string') {
        errors.push('runtimeConfig.runtime is required (e.g. onnxruntime, openvino)');
      }
      if (!rc.modelFormat || typeof rc.modelFormat !== 'string') {
        errors.push('runtimeConfig.modelFormat is required (e.g. ONNX)');
      }
      if (typeof rc.inputWidth !== 'number' || rc.inputWidth <= 0) {
        errors.push('runtimeConfig.inputWidth must be a positive integer');
      }
      if (typeof rc.inputHeight !== 'number' || rc.inputHeight <= 0) {
        errors.push('runtimeConfig.inputHeight must be a positive integer');
      }
      if (!rc.colorSpace || !['RGB', 'BGR', 'GRAY'].includes(rc.colorSpace.toUpperCase())) {
        errors.push('runtimeConfig.colorSpace must be RGB, BGR, or GRAY');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Registers a ModelManifest into the database with strict immutability checks.
   * If the model version is already registered:
   * - If sha256 matches, returns existing record (idempotent registration).
   * - If sha256 or parameters differ, rejects to prevent mutating historical identity.
   */
  public async registerModelManifest(input: CreateModelManifestInput): Promise<ModelManifest> {
    const validation = this.validateModelManifest(input);
    if (!validation.valid) {
      throw new Error(`Model manifest validation failed: ${validation.errors.join('; ')}`);
    }

    const normCodeLicense = this.normalizeSpdx(input.codeLicense);
    const normWeightLicense = this.normalizeSpdx(input.weightLicense);
    const inferredObligations = this.inferLicenseObligations(normWeightLicense);

    const existing = await this.prisma.modelManifest.findUnique({
      where: {
        name_version: {
          name: input.name,
          version: input.version,
        },
      },
    });

    if (existing) {
      if (existing.sha256.toLowerCase() !== input.sha256.toLowerCase()) {
        throw new Error(
          `Model version immutability violation: Model '${input.name}' version '${input.version}' is already registered with sha256 '${existing.sha256}'. Model weights must not be mutated in place; register a new version instead.`
        );
      }
      // Immutable artifact match. A registration made before the Phase 2 columns existed may lack
      // the decoding contract; fill those once, never overwrite them.
      if (!existing.modelSignatureJson && input.modelSignature) {
        return this.prisma.modelManifest.update({
          where: { id: existing.id },
          data: {
            task: input.task ?? existing.task,
            weightsSource: existing.weightsSource ?? input.weightsSource,
            modelSignatureJson: input.modelSignature as any,
            classesJson: (input.classes as any) ?? undefined,
            nmsConfigJson: (input.nmsConfig as any) ?? undefined,
          },
        });
      }
      return existing;
    }

    return this.prisma.modelManifest.create({
      data: {
        name: input.name,
        version: input.version,
        sha256: input.sha256.toLowerCase(),
        codeLicense: normCodeLicense,
        weightLicense: normWeightLicense,
        trainingDataJson: input.trainingData as any,
        thresholdsJson: input.thresholds ? (input.thresholds as any) : undefined,
        runtimeConfigJson: input.runtimeConfig as any,
        attributionRequired: input.attributionRequired ?? inferredObligations.attributionRequired,
        noticeRequired: input.noticeRequired ?? inferredObligations.noticeRequired,
        licenseNotes: input.licenseNotes ?? inferredObligations.licenseNotes,
        isActive: input.isActive ?? true,
        task: input.task ?? 'object_detection',
        weightsSource: input.weightsSource,
        modelSignatureJson: (input.modelSignature as any) ?? undefined,
        classesJson: (input.classes as any) ?? undefined,
        nmsConfigJson: (input.nmsConfig as any) ?? undefined,
      },
    });
  }

  /**
   * Looks up a model manifest by ID.
   */
  public async getModelManifest(id: string): Promise<ModelManifest | null> {
    return this.prisma.modelManifest.findUnique({
      where: { id },
    });
  }

  /**
   * Looks up an active model manifest by name and version.
   */
  public async getActiveModelManifest(name: string, version: string): Promise<ModelManifest | null> {
    return this.prisma.modelManifest.findFirst({
      where: {
        name,
        version,
        isActive: true,
      },
    });
  }

  /**
   * Lists all model manifests.
   */
  public async listModelManifests(filter?: { isActive?: boolean }): Promise<ModelManifest[]> {
    return this.prisma.modelManifest.findMany({
      where: filter ? { isActive: filter.isActive } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
}
