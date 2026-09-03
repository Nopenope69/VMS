import { AuditChainService, GENESIS_HASH } from '../services/audit/auditChain.service';

describe('Tamper-Evident Audit Event Hash Chain', () => {
  it('should compute valid SHA-256 event hash linked to predecessor', () => {
    const timestamp = new Date();
    const hash = AuditChainService.computeEventHash(
      GENESIS_HASH,
      timestamp,
      'tenant_test',
      'user_123',
      'CAMERA_CREATE',
      'Camera',
      'cam_abc',
      { name: 'Gate Camera' }
    );

    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('should verify mathematical integrity of consecutive chained events', () => {
    const t0 = new Date('2026-09-04T00:00:00Z');
    const t1 = new Date('2026-09-04T00:01:00Z');
    const t2 = new Date('2026-09-04T00:02:00Z');

    // Event 1 (Genesis link)
    const hash1 = AuditChainService.computeEventHash(
      GENESIS_HASH,
      t0,
      'tenant_test',
      'admin',
      'SYSTEM_BOOTSTRAP',
      'Tenant',
      'tenant_test',
      null
    );

    // Event 2 (links to Event 1)
    const hash2 = AuditChainService.computeEventHash(
      hash1,
      t1,
      'tenant_test',
      'admin',
      'CAMERA_CREATE',
      'Camera',
      'cam_01',
      { name: 'Entrance' }
    );

    // Event 3 (links to Event 2)
    const hash3 = AuditChainService.computeEventHash(
      hash2,
      t2,
      'tenant_test',
      'admin',
      'EXPORT_EVIDENCE_BSA63',
      'Camera',
      'cam_01',
      { format: 'mp4' }
    );

    // Simulated verification of the 3 events
    const chain = [
      { prevHash: GENESIS_HASH, eventHash: hash1, timestamp: t0, action: 'SYSTEM_BOOTSTRAP', meta: null },
      { prevHash: hash1, eventHash: hash2, timestamp: t1, action: 'CAMERA_CREATE', meta: { name: 'Entrance' } },
      { prevHash: hash2, eventHash: hash3, timestamp: t2, action: 'EXPORT_EVIDENCE_BSA63', meta: { format: 'mp4' } },
    ];

    let currentExpected = GENESIS_HASH;
    for (const item of chain) {
      expect(item.prevHash).toBe(currentExpected);
      const recomputed = AuditChainService.computeEventHash(
        item.prevHash,
        item.timestamp,
        'tenant_test',
        'admin',
        item.action,
        item.action === 'SYSTEM_BOOTSTRAP' ? 'Tenant' : 'Camera',
        item.action === 'SYSTEM_BOOTSTRAP' ? 'tenant_test' : 'cam_01',
        item.meta
      );
      expect(recomputed).toBe(item.eventHash);
      currentExpected = item.eventHash;
    }
  });

  it('should immediately detect if a row in the audit log was tampered with', () => {
    const t0 = new Date('2026-09-04T00:00:00Z');
    const hash1 = AuditChainService.computeEventHash(
      GENESIS_HASH,
      t0,
      'tenant_test',
      'admin',
      'CAMERA_CREATE',
      'Camera',
      'cam_01',
      { ip: '192.168.1.50' }
    );

    // Tampered: malicious DB user tries to rewrite the action or metadata
    const tamperedMetadata = { ip: '192.168.1.99' };
    const recomputed = AuditChainService.computeEventHash(
      GENESIS_HASH,
      t0,
      'tenant_test',
      'admin',
      'CAMERA_CREATE',
      'Camera',
      'cam_01',
      tamperedMetadata
    );

    // Hash mismatch exposes the tampering
    expect(recomputed).not.toBe(hash1);
  });
});
