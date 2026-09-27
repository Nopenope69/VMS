import crypto from 'crypto';
import fs from 'fs';
import { ModelManifestRecord, RuntimeConfig } from './types';

/** Licences allowed for model code and weights (action plan: permissive only). */
export const PERMISSIVE_MODEL_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

export type ModelRefusalCode = 'MODEL_INTEGRITY_FAILED' | 'LICENSE_REJECTED' | 'ARTIFACT_MISSING' | 'INVALID_RUNTIME_CONFIG';

/** Typed refusal so callers can report it (audit chain) and map it to ai-adapter.v1 error codes. */
export class ModelRefusalError extends Error {
  constructor(public readonly code: ModelRefusalCode, message: string, public readonly computedSha256?: string) {
    super(message);
    this.name = 'ModelRefusalError';
  }
}

export interface LoadedModelArtifact {
  manifest: ModelManifestRecord;
  artifactPath: string;
  sha256: string;
  verified: boolean;
  buffer: Buffer;
}

export class ModelLoader {
  /**
   * Computes authentic SHA-256 hash of the physical model weights artifact.
   */
  public static async computeArtifactHash(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new ModelRefusalError('ARTIFACT_MISSING', `Model artifact file not found: ${filePath}`);
    }

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    });
  }

  /**
   * Verifies runtime configuration compatibility against environment capabilities.
   */
  public static verifyRuntimeConfig(config: RuntimeConfig): boolean {
    if (!config || typeof config !== 'object') {
      throw new Error('Missing runtime configuration');
    }

    // 'mock-runtime' is a test fixture only (NODE_ENV=test); never a runtime fallback.
    const supportedRuntimes =
      process.env.NODE_ENV === 'test' ? ['onnxruntime', 'openvino', 'mock-runtime'] : ['onnxruntime', 'openvino'];
    if (!supportedRuntimes.includes(config.runtime.toLowerCase())) {
      throw new Error(`Unsupported runtime: '${config.runtime}'. Supported: ${supportedRuntimes.join(', ')}`);
    }

    if (!config.inputWidth || config.inputWidth <= 0 || !config.inputHeight || config.inputHeight <= 0) {
      throw new Error(`Invalid input tensor dimensions: ${config.inputWidth}x${config.inputHeight}`);
    }

    const supportedColorSpaces = ['RGB', 'BGR', 'GRAY'];
    if (!supportedColorSpaces.includes(config.colorSpace?.toUpperCase())) {
      throw new Error(`Unsupported color space: '${config.colorSpace}'`);
    }

    return true;
  }

  /**
   * Loads a model artifact from disk, strictly verifying its cryptographic SHA-256
   * against the registered ModelManifest.
   *
   * INVARIANT: If the SHA-256 does not match exactly, the loader REFUSES to load the model.
   */
  public static async loadAndVerify(
    manifest: ModelManifestRecord,
    artifactPath: string
  ): Promise<LoadedModelArtifact> {
    // 1. Licences: refuse anything outside the permissive allowlist before touching the bytes.
    for (const [kind, lic] of [['code', manifest.codeLicense], ['weights', manifest.weightLicense]] as const) {
      if (!PERMISSIVE_MODEL_LICENSES.includes((lic || '').trim())) {
        throw new ModelRefusalError(
          'LICENSE_REJECTED',
          `REFUSING TO LOAD '${manifest.name}:${manifest.version}': ${kind} licence '${lic}' is not one of ${PERMISSIVE_MODEL_LICENSES.join(', ')}`
        );
      }
    }

    // 2. Verify runtime configuration integrity
    try {
      ModelLoader.verifyRuntimeConfig(manifest.runtimeConfigJson);
    } catch (err: any) {
      throw new ModelRefusalError('INVALID_RUNTIME_CONFIG', err.message);
    }

    // 3. Compute authentic SHA-256 from installed artifact bytes
    const computedHash = await ModelLoader.computeArtifactHash(artifactPath);
    const expectedHash = manifest.sha256.toLowerCase();

    // 4. Strict cryptographic equality gate
    if (computedHash !== expectedHash) {
      throw new ModelRefusalError(
        'MODEL_INTEGRITY_FAILED',
        `FATAL: Model artifact SHA-256 mismatch for '${manifest.name}:${manifest.version}'. ` +
          `Expected: ${expectedHash}, Computed: ${computedHash}. REFUSING TO LOAD UNVERIFIED MODEL ARTIFACT.`,
        computedHash
      );
    }

    const buffer = fs.readFileSync(artifactPath);

    return {
      manifest,
      artifactPath,
      sha256: computedHash,
      verified: true,
      buffer,
    };
  }
}
