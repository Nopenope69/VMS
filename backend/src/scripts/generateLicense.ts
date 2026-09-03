import crypto from 'crypto';
import { signLicensePayload, LicenseClaims, LicenseTier } from '../utils/license';

function parseArgs() {
  const args = process.argv.slice(2);
  const params: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      params[args[i].slice(2)] = args[i + 1];
    }
  }

  return params;
}

function run() {
  const params = parseArgs();

  const tenantId = params.tenant || 'default-facility';
  const tier = (params.tier?.toUpperCase() || 'ENTERPRISE') as LicenseTier;
  const maxCameras = parseInt(params.cameras || '16', 10);
  const days = params.days ? parseInt(params.days, 10) : null;
  const installationId = params.installation || undefined;

  const now = new Date();
  const expiresAt = days ? new Date(now.getTime() + days * 86400000).toISOString() : null;

  const featuresByTier: Record<LicenseTier, string[]> = {
    BASIC: ['EVIDENCE_EXPORT'],
    PROFESSIONAL: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ', 'MULTI_SITE'],
    ENTERPRISE: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ', 'MULTI_SITE', 'ANPR', 'AUDIT_INTEGRITY'],
  };

  const claims: LicenseClaims = {
    licenseId: `lic_${crypto.randomBytes(8).toString('hex')}`,
    tenantId,
    tier,
    maxCameras,
    features: featuresByTier[tier] || featuresByTier.BASIC,
    issuedAt: now.toISOString(),
    expiresAt,
    installationId,
  };

  const artifact = signLicensePayload(claims);

  console.log('\n=== VigilOne Signed Commercial License Artifact ===\n');
  console.log(JSON.stringify(artifact, null, 2));
  console.log('\n===================================================\n');
}

if (require.main === module) {
  run();
}
