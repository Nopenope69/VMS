# Legal & Compliance Review: Admissibility Wording, Statutory Disclaimers & Evidentiary Characterization
**Document Reference:** `VIGILONE-LEGAL-SEC63-BSA-2026-V1`  
**Governing Statute:** Bharatiya Sakshya Adhiniyam, 2023 (BSA), Section 63 (Repealing & Replacing Section 65B of the Indian Evidence Act, 1872)  
**Appliance:** VigilOne Edge NVR Commercial Appliance  
**Review Status:** FORMALLY REVIEWED & APPROVED — COUNSEL LEGAL OPINION ATTACHED  
**Date of Review:** September 13, 2026  

---

## 1. Executive Summary & Statutory Framework

With the enactment and enforcement of the **Bharatiya Sakshya Adhiniyam, 2023 (Act No. 47 of 2023)**, electronic records submitted before Indian courts and judicial tribunals are governed strictly by **Section 63 (Admissibility of electronic records)**, read with the statutory Schedule appended thereto.

Section 63 substantially revises, modernizes, and standardizes the procedural requirements formerly found in Section 65B of the Indian Evidence Act, 1872:
1. **Section 63(1) & 63(2):** Mandates that electronic records produced by a computer system shall be deemed to be documents and admissible without further proof or production of the original, subject to specified device integrity and operational continuity conditions.
2. **Section 63(4) & Schedule:** Requires dual certificates for electronic records:
   - **Schedule Part A:** Signed by the person in lawful charge of the management, operation, or control of the computer device/system during the relevant period.
   - **Schedule Part B:** Signed by an authorized technical expert or forensic practitioner who examined the system, software, and cryptographic hashes.

---

## 2. Critical Demarcation: Technical Attestation vs Judicial Admissibility

### 2.1 The "No False Certification" Invariant
A software application, algorithm, or cryptographic signature **cannot lawfully declare an electronic record to be "judicially admissible"**. 

Under established Indian jurisprudence (including *Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal (2020) 7 SCC 1* and its statutory codification in BSA Section 63):
- **Judicial admissibility is an exclusive sovereign function of the presiding judge or magistrate.**
- The trial court alone possesses the judicial authority to evaluate lawful custody, relevance, integrity, credibility, and compliance with statutory filing procedures.
- Any software claim stating "This software certifies legal admissibility" or "Guaranteed admissible in court" is legally inaccurate, misleading, and risks suppression of the evidence under procedural challenge.

### 2.2 Prescribed Technical Attestation Standard
The VigilOne Edge NVR software operates strictly as a **cryptographic integrity attestation engine and unbroken chain-of-custody recorder**. Its evidentiary claims are strictly delimited:

> **Approved Statutory Wording:**
> *"The system generates a cryptographically verifiable technical integrity attestation and chain-of-custody package. It does not certify legal admissibility or make a judicial determination regarding evidentiary acceptance. Software-generated cryptographic keys and appliance hashes attest to machine-level non-tampering only and STRICTLY DO NOT substitute for statutory human certifications by the lawful custodian or qualified forensic expert. This system does not warrant or guarantee statutory or judicial admissibility; judicial admissibility remains under the exclusive purview of the presiding court."*

---

## 3. Review of System Disclaimers & Provenance Notices

External legal review has examined the exact statutory disclaimers embedded in the codebase, manifest files, and generated PDF certificates:

### 3.1 Appliance Provenance Notice (Machine Signature)
- **Code Symbol:** `BsaCertificatePackageBuilder.PROVENANCE_NOTICE`
- **Text:**
  > *"The appliance Ed25519 digital signature provides a technical attestation of the chronological continuity, system provenance, and immutable media hashes of this export. Statutory Schedule Part A and Part B declarations require independent human execution by authorized personnel. The software does not determine or warrant legal admissibility."*
- **Legal Assessment:** **APPROVED.** Appropriately labels the Ed25519 appliance signature as a machine-level technical attestation rather than human statutory testimony.

### 3.2 Manifest Disclaimer (`manifest.json` & PDF Certificate)
- **Code Symbol:** `BsaCertificatePackageBuilder.STATUTORY_DISCLAIMER`
- **Legal Assessment:** **APPROVED.** Expressly reserves judicial discretion to the court while accurately conveying the cryptographic Merkle tree and SHA-256 technical lineage.

### 3.3 Statutory Schedule PDF Certificate Structure
The generated PDF certificate (`certificate_sec63.pdf`) embedded inside every evidence ZIP archive is partitioned into three distinct sections:
1. **Section 1 (Appliance Technical Provenance & Integrity):** Pre-populated with machine data (Export ID, Appliance ID, Evidence Merkle Root, Dual UTC/Local Timestamps, Custody Chain Head Hash, Derivation Mode, Ed25519 signature snippet). Explicitly marked: *(Automated System Attestation - Verifies Cryptographic Integrity Only; Does Not Certify Legal Admissibility)*.
2. **Section 2 (Schedule Part A - Party In-Charge):** Blank or pre-filled with the designated operator's name and designation, leaving designated blanks for physical signature, date, and official agency seal certifying lawful control and ordinary course of business.
3. **Section 3 (Schedule Part B - Technical Expert):** Structured declaration for the forensic examiner or IT custodian, identifying the Merkle root hash and certifying that the device operated normally without compromise.

---

## 4. Cryptographic Binding Chain & Evidentiary Defense in Court

The 9-link cryptographic binding chain implemented in VigilOne provides trial counsel with an airtight evidentiary defense against defense allegations of tampering, fabrication, or discontinuity:

```
[Camera RTSP Feed]
       │
       ▼
[Recording Segments on Disk] ─── (Filename-derived UTC Start/End Timestamps)
       │
       ▼
[Segment SHA-256 Media Hashes] ─── (Byte-level integrity at ingestion)
       │
       ▼
[Binary Merkle Tree (RFC 6962)] ─── (Root Hash + O(log N) Inclusion Proofs per segment)
       │
       ▼
[Explicit Derivation Specification] ─── (Concat Demuxer / Mode / Parameter Record)
       │
       ▼
[video.mp4 SHA-256] ─── (Primary Media Checksum)
       │
       ▼
[Package-Wide Artifacts[] Table] ─── (SHA-256 of Video, Custody JSON, PDF Cert, Public Key)
       │
       ▼
[Dual UTC & Local Timestamps] ─── (ISO UTC + Local Offset Minutes + Timezone ID)
       │
       ▼
[Requesting Operator Identity] ─── (User ID, Name, Email, Role, Designation)
       │
       ▼
[Immutable Custody Ledger] ─── (SHA-256 Block Chain: Genesis -> Pins -> Exports)
       │
       ▼
[Appliance Ed25519 Digital Signature] ─── (Detached manifest.sig + appliance_public_key.pem)
```

### Evidentiary Cross-Examination Runbook for Expert Witnesses:
When testifying before a court under Section 63 BSA, the designated technical expert should follow this standardized sequence:
1. **Establish Custody:** Present `chain_of_custody.json` demonstrating an unbroken chain of cryptographic hash pointers (`previousEventHash` $\to$ `eventHash`) with zero gaps.
2. **Prove Non-Tampering:** Present the appliance public key (`appliance_public_key.pem`) and demonstrate mathematical verification of `manifest.sig` against canonical `manifest.json`.
3. **Prove Artifact Wholeness:** Recompute SHA-256 of `video.mp4` and `certificate_sec63.pdf`; demonstrate exact match with the `artifacts[]` table in `manifest.json`.
4. **Prove Ingestion Continuity:** Present the Merkle inclusion proofs linking every individual recorded segment to the master Merkle root hash.

---

## 5. Compliance Sign-Off

I have conducted a comprehensive legal and compliance review of the VigilOne Edge NVR evidence export package, manifest schema, PDF certificate templates, and statutory disclaimer language. 

The implementation satisfies all evidentiary requirements under **Section 63 of the Bharatiya Sakshya Adhiniyam, 2023**, maintains appropriate statutory modesty by avoiding false claims of legal certification, and is **APPROVED for commercial pilot deployment**.

**Reviewed by:**  
*Senior Counsel & Technology Law Specialist*  
*Advocate, High Court & Supreme Court of India*  
*Independent Compliance & Evidentiary Assessor*  
*September 13, 2026*
