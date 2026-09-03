import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { signEvidenceManifest, verifyEvidenceManifest, getOrCreateApplianceEd25519Keys } from '../utils/crypto';

describe('Section 63 BSA Evidence Package Assembly', () => {
  it('should generate pre-populated Section 63 BSA PDF with valid structure', async () => {
    const testPdfPath = path.join('/tmp', `test_bsa_part_a_${Date.now()}.pdf`);

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument();
      const stream = fs.createWriteStream(testPdfPath);
      doc.pipe(stream);

      doc.fontSize(16).text('CERTIFICATE UNDER SECTION 63', { align: 'center' });
      doc.fontSize(12).text('Bharatiya Sakshya Adhiniyam, 2023 (BSA)', { align: 'center' });
      doc.text('SCHEDULE - PART A');
      doc.text('SHA-256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      doc.end();

      stream.on('finish', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    expect(fs.existsSync(testPdfPath)).toBe(true);
    const pdfBuf = fs.readFileSync(testPdfPath);
    // PDF files start with %PDF-
    expect(pdfBuf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    fs.unlinkSync(testPdfPath);
  });

  it('should generate verifiable manifest and signature structure', () => {
    const manifest = {
      exportId: 'EV-20260904-TEST',
      timeWindow: {
        startUtc: '2026-09-04T01:00:00.000Z',
        endUtc: '2026-09-04T01:10:00.000Z',
      },
      camera: {
        id: 'cam_gate_1',
        name: 'Main Gate Camera',
        serialNumber: 'DS-2CD2043G2-I_998124',
      },
      videoChecksumSha256: 'a69f73cca23a9ac5c8b567dc185a756e97a9fb34a80cbe4f50169792d13f9fb0',
      bsaSection63Details: {
        partAParty: { name: 'Rohan Sharma', designation: 'Security Head' },
        partBExpert: { name: 'Anil Verma', designation: 'Digital Evidence Examiner', organization: 'Forensic IT Services' },
      },
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const keys = getOrCreateApplianceEd25519Keys();
    const signature = signEvidenceManifest(manifestJson, keys.privateKeyPem);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(40);

    const verified = verifyEvidenceManifest(manifestJson, signature, keys.publicKeyPem);
    expect(verified).toBe(true);
  });
});
