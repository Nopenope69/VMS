export const PERMISSIVE_LICENSES = new Set([
  'mit',
  'apache-2.0',
  'apache 2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'mpl-2.0',
  'mozilla public license 2.0',
  'unlicense',
]);

export interface ModelManifestInput {
  tenantId: string;
  version: string;
  sha256: string;
  codeLicense?: string | null;
  weightLicense?: string | null;
  trainingData?: string | null;
  thresholdsJson?: Record<string, unknown> | null;
}

export interface ModelManifestValidationResult {
  valid: boolean;
  errors: string[];
}

export function isPermissiveLicense(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return PERMISSIVE_LICENSES.has(normalized);
}

export function validateModelManifest(input: ModelManifestInput): ModelManifestValidationResult {
  const errors: string[] = [];

  if (!input.version || !input.version.trim()) {
    errors.push('Model version is required.');
  }

  if (!input.sha256 || !/^[a-f0-9]{64}$/i.test(input.sha256.trim())) {
    errors.push('Model sha256 must be a valid 64-character hex digest.');
  }

  if (!input.codeLicense || !input.codeLicense.trim()) {
    errors.push('Model code license is required.');
  } else if (!isPermissiveLicense(input.codeLicense)) {
    errors.push(`Model code license '${input.codeLicense}' is not permissive. Use MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, or another allowlisted permissive license.`);
  }

  if (!input.weightLicense || !input.weightLicense.trim()) {
    errors.push('Model weight license is required.');
  } else if (!isPermissiveLicense(input.weightLicense)) {
    errors.push(`Model weight license '${input.weightLicense}' is not permissive. Use MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, or another allowlisted permissive license.`);
  }

  if (!input.trainingData || !input.trainingData.trim()) {
    errors.push('Training data provenance is required.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
