import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { signLicensePayload, verifyLicenseArtifact, LicenseClaims, LicenseTier } from '../utils/license';
import { VENDOR_LICENSE_PUBLIC_KEY } from '../config/licenseKeys';

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

export function runMint() {
  const params = parseArgs();

  const keyPath = params.key || process.env.VENDOR_LICENSE_PRIVATE_KEY_PATH;
  const privateKeyPem = keyPath
    ? fs.readFileSync(path.resolve(keyPath), 'utf8')
    : process.env.VENDOR_LICENSE_PRIVATE_KEY;

  if (!privateKeyPem) {
    console.error('\n[FATAL ERROR] Offline license signing requires a vendor private key PEM.');
    console.error('Usage: ts-node mintLicense.ts --key <path/to/private.pem> [options]');
    console.error('   or: VENDOR_LICENSE_PRIVATE_KEY="<PEM>" ts-node mintLicense.ts [options]\n');
    console.error('Options:');
    console.error('  --tenant       Tenant ID (default: default-facility)');
    console.error('  --tier         BASIC | PROFESSIONAL | ENTERPRISE (default: ENTERPRISE)');
    console.error('  --cameras      Max camera quota (default: 16)');
    console.error('  --days         Validity in days (omit for perpetual)');
    console.error('  --kid          Key identifier (e.g. root-2026-09)');
    console.error('  --device       Appliance hardware binding UUID');
    console.error('  --out          Save output JSON to file\n');
    process.exit(1);
  }

  const tenantId = params.tenant || 'default-facility';
  const tier = (params.tier?.toUpperCase() || 'ENTERPRISE') as LicenseTier;
  const maxCameras = parseInt(params.cameras || '16', 10);
  const days = params.days ? parseInt(params.days, 10) : null;
  const installationId = params.installation || undefined;
  const deviceBinding = params.device || undefined;
  const kid = params.kid || 'root-2026-09';

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
    deviceBinding,
    kid,
  };

  const artifact = signLicensePayload(claims, privateKeyPem.trim());

  // Self-verification check against embedded public key
  const selfCheck = verifyLicenseArtifact(artifact.signedPayload, artifact.signatureEd25519, VENDOR_LICENSE_PUBLIC_KEY);
  if (!selfCheck.valid) {
    console.warn('\n[WARNING] The generated signature does NOT verify against the current embedded VENDOR_LICENSE_PUBLIC_KEY.');
    console.warn('Ensure that the private key corresponds to the appliance public key trust anchor.\n');
  }

  const output = JSON.stringify(artifact, null, 2);

  if (params.out) {
    fs.writeFileSync(path.resolve(params.out), output, 'utf8');
    console.log(`\nLicense artifact written to: ${params.out}`);
  } else {
    console.log('\n=== VigilOne Signed Commercial License Artifact ===\n');
    console.log(output);
    console.log('\n===================================================\n');
  }

  return artifact;
}

if (require.main === module) {
  runMint();
}
