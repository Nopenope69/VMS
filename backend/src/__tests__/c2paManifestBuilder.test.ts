import crypto from 'crypto';
import {
  buildC2paManifest,
  verifyC2paManifest,
  C2paManifestInput,
  C2paManifest,
} from '../services/evidence/archive/c2paManifestBuilder';
import { getOrCreateApplianceEd25519Keys } from '../utils/crypto';
import { canonicalizeJson } from '../services/evidence/archive/canonicalJson';

describe('C2PA Manifest Builder and Verifier (c2paManifestBuilder)', () => {
  const dummyInput: C2paManifestInput = {
    exportId: 'c2pa-exp-1234',
    title: 'Incident Evidentiary Export 1234',
    format: 'video/mp4',
    applianceIdentifier: 'VIGILONE-EDGE-TEST',
    tenantId: 'tenant-test-uuid',
    startUtc: new Date('2026-10-10T10:00:00.000Z'),
    endUtc: new Date('2026-10-10T10:05:00.000Z'),
    videoSha256: 'a'.repeat(64),
    evidenceMerkleRoot: 'b'.repeat(64),
    segmentCount: 5,
    partAPartyName: 'Officer Rajiv Sharma',
    partAPartyDesignation: 'Senior Surveillance Officer',
    partBExpertName: 'Dr. Priya Desai',
    custodyChainHeadHash: 'c'.repeat(64),
    aiProvenanceSummary: {
      recordCount: 42,
      unattributedCount: 0,
      models: [{ name: 'yolox-test', version: '1.0.0', sha256: 'd'.repeat(64) }],
    },
    signingTime: new Date('2026-10-10T10:06:00.000Z'),
  };

  it('builds a valid C2PA 2.2 manifest conforming to specifications', () => {
    const { manifestJson, manifestObj } = buildC2paManifest(dummyInput);

    expect(manifestObj.c2pa_version).toBe('2.2');
    expect(manifestObj.claim_generator).toBe('VigilOne Edge VMS/1.0.0');
    expect(manifestObj.claim_generator_info).toEqual([
      { name: 'VigilOne Edge VMS', version: '1.0.0' },
    ]);
    expect(manifestObj.title).toBe('Incident Evidentiary Export 1234');
    expect(manifestObj.format).toBe('video/mp4');
    expect(manifestObj.instance_id).toBe('urn:uuid:c2pa-exp-1234');

    // Assertions checks
    const assertions = manifestObj.assertions;
    const actionsAssertion = assertions.find((a) => a.label === 'c2pa.actions');
    expect(actionsAssertion).toBeDefined();
    expect(actionsAssertion?.data.actions).toEqual([
      expect.objectContaining({
        action: 'c2pa.created',
        when: '2026-10-10T10:00:00.000Z',
        softwareAgent: 'VigilOne Media Plane',
      }),
      expect.objectContaining({
        action: 'c2pa.packaged',
        when: '2026-10-10T10:06:00.000Z',
        softwareAgent: 'VigilOne Evidence Subsystem',
      }),
    ]);

    const hashAssertion = assertions.find((a) => a.label === 'c2pa.hash.data');
    expect(hashAssertion).toBeDefined();
    expect(hashAssertion?.data).toEqual({
      name: 'primary_media',
      alg: 'sha256',
      hash: 'a'.repeat(64),
      pad: 0,
    });

    const creativeWork = assertions.find((a) => a.label === 'stds.schema-org.CreativeWork');
    expect(creativeWork).toBeDefined();
    expect(creativeWork?.data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: 'Incident Evidentiary Export 1234',
      contentUrl: 'video.mp4',
      dateCreated: '2026-10-10T10:00:00.000Z',
      dateModified: '2026-10-10T10:05:00.000Z',
      author: {
        '@type': 'Person',
        name: 'Officer Rajiv Sharma',
      },
      producer: {
        '@type': 'Organization',
        name: 'VigilOne Edge Appliance',
        identifier: 'VIGILONE-EDGE-TEST',
      },
    });

    const bsa = assertions.find((a) => a.label === 'in.gov.bsa.section63');
    expect(bsa).toBeDefined();
    expect(bsa?.data).toEqual({
      statute: 'Bharatiya Sakshya Adhiniyam, 2023 - Section 63',
      applianceIdentifier: 'VIGILONE-EDGE-TEST',
      evidenceMerkleRoot: 'b'.repeat(64),
      segmentCount: 5,
      custodyChainHeadHash: 'c'.repeat(64),
      partAPartyName: 'Officer Rajiv Sharma',
      partAPartyDesignation: 'Senior Surveillance Officer',
      partBExpertName: 'Dr. Priya Desai',
    });

    const ai = assertions.find((a) => a.label === 'c2pa.ai_provenance');
    expect(ai).toBeDefined();
    expect(ai?.data.recordCount).toBe(42);
    expect(ai?.data.models).toHaveLength(1);

    // Signature info
    expect(manifestObj.signature_info).toBeDefined();
    expect(manifestObj.signature_info.alg).toBe('ed25519');
    expect(manifestObj.signature_info.issuer).toBe('VIGILONE-EDGE-TEST');
    expect(manifestObj.signature_info.time).toBe('2026-10-10T10:06:00.000Z');
    expect(typeof manifestObj.signature_info.signature).toBe('string');
    expect(manifestObj.signature_info.signature.length).toBeGreaterThan(0);

    // Verify against helper
    const verification = verifyC2paManifest(manifestJson);
    expect(verification.valid).toBe(true);
    expect(verification.reason).toBeUndefined();
  });

  it('verifies manifest object directly as well as json string', () => {
    const { manifestObj } = buildC2paManifest(dummyInput);
    const verification = verifyC2paManifest(manifestObj);
    expect(verification.valid).toBe(true);
  });

  it('verifies signature against appliance public key or supplied trusted key', () => {
    const { manifestJson } = buildC2paManifest(dummyInput);
    const { publicKeyPem } = getOrCreateApplianceEd25519Keys();
    const verification = verifyC2paManifest(manifestJson, publicKeyPem);
    expect(verification.valid).toBe(true);

    // Untrusted key fails
    const fakeKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const failedVerification = verifyC2paManifest(manifestJson, fakeKey);
    expect(failedVerification.valid).toBe(false);
    expect(failedVerification.reason).toMatch(/signature|key/i);
  });

  it('detects tampering with videoSha256 hash', () => {
    const { manifestObj } = buildC2paManifest(dummyInput);
    const tampered = JSON.parse(JSON.stringify(manifestObj)) as C2paManifest;
    const hashData = tampered.assertions.find((a) => a.label === 'c2pa.hash.data');
    if (hashData) {
      hashData.data.hash = 'f'.repeat(64);
    }
    const result = verifyC2paManifest(canonicalizeJson(tampered));
    expect(result.valid).toBe(false);
  });

  it('detects tampering with Section 63 BSA assertion data', () => {
    const { manifestObj } = buildC2paManifest(dummyInput);
    const tampered = JSON.parse(JSON.stringify(manifestObj)) as C2paManifest;
    const bsa = tampered.assertions.find((a) => a.label === 'in.gov.bsa.section63');
    if (bsa) {
      bsa.data.evidenceMerkleRoot = '0'.repeat(64);
    }
    const result = verifyC2paManifest(canonicalizeJson(tampered));
    expect(result.valid).toBe(false);
  });

  it('detects corrupted or forged signature', () => {
    const { manifestObj } = buildC2paManifest(dummyInput);
    const tampered = JSON.parse(JSON.stringify(manifestObj)) as C2paManifest;
    tampered.signature_info.signature = Buffer.from('corrupted_signature').toString('base64');
    const result = verifyC2paManifest(canonicalizeJson(tampered));
    expect(result.valid).toBe(false);
  });

  it('detects unsupported c2pa_version or missing claim_generator', () => {
    const { manifestObj } = buildC2paManifest(dummyInput);
    const badVersion = { ...manifestObj, c2pa_version: '1.0' as any };
    expect(verifyC2paManifest(badVersion).valid).toBe(false);

    const badGenerator = { ...manifestObj, claim_generator: '' };
    expect(verifyC2paManifest(badGenerator).valid).toBe(false);
  });

  it('correctly preserves 0 segmentCount in BSA Section 63 assertion', () => {
    const { manifestObj } = buildC2paManifest({ ...dummyInput, segmentCount: 0 });
    const bsa = manifestObj.assertions.find((a) => a.label === 'in.gov.bsa.section63');
    expect(bsa?.data.segmentCount).toBe(0);
    expect(verifyC2paManifest(manifestObj).valid).toBe(true);
  });
});
