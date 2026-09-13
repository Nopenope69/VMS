# Internal Engineering Specification: Section 63 BSA Evidentiary Implementation & Statutory Disclaimer Architecture

**Document Reference:** `VIGILONE-ENG-SPEC-SEC63-BSA-V1`  
**Governing Statute:** Bharatiya Sakshya Adhiniyam, 2023 (BSA), Section 63 (Repealing & Replacing Section 65B of the Indian Evidence Act, 1872)  
**Appliance:** VigilOne Edge NVR Commercial Appliance  
**Document Type:** Internal Engineering Specification & Self-Assessment  
**Date:** September 13, 2026  
**Author:** VigilOne Core Systems Architecture & Security Engineering Team  

---

> [!CAUTION]
> **STATUTORY & EVIDENTIARY DISCLAIMER (INTERNAL ENGINEERING DOCUMENT)**
> This document is an **internal software engineering specification** describing how the VigilOne Edge NVR implements cryptographic hashing, Merkle trees, and automated metadata export.
> 
> **This document is NOT a formal legal opinion, does NOT constitute legal advice, and was NOT reviewed or endorsed by external legal counsel or advocates.**
> 
> Neither this software nor this specification can certify judicial admissibility. Under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023, electronic records require independent statutory certifications by human beings (Schedule Part A by the lawful custodian, and Schedule Part B by a qualified forensic or technical expert). The ultimate determination of admissibility resides exclusively within the judicial discretion of the presiding court. Customers deploying VigilOne must have their own legal counsel review evidence packages prior to tendering them in judicial proceedings.

---

## 1. Statutory Context & Technical Scope

With the enactment of the **Bharatiya Sakshya Adhiniyam, 2023 (Act No. 47 of 2023)**, electronic records submitted before Indian courts and judicial tribunals are governed by **Section 63 (Admissibility of electronic records)**, read with the statutory Schedule appended thereto.

Section 63 standardizes procedural requirements formerly addressed under Section 65B of the Indian Evidence Act, 1872:
1. **Section 63(1) & 63(2):** Deals with electronic records produced by a computer system and conditions regarding device integrity and operational continuity during the period over which the computer was used regularly.
2. **Section 63(4) & Schedule:** Provides for certificates accompanying electronic records:
   - **Schedule Part A:** Executed by the person in lawful charge of the management, operation, or control of the computer device/system during the relevant period.
   - **Schedule Part B:** Executed by an authorized technical expert or forensic practitioner who examined the system, software, and cryptographic hashes.

This specification documents the cryptographic and software mechanisms VigilOne implements to assist human custodians in satisfying these statutory evidentiary requirements without making false claims of automated judicial acceptance.

---

## 2. Critical Demarcation: Technical Attestation vs Judicial Admissibility

### 2.1 The "No False Certification" Invariant
A software application, algorithm, or cryptographic signature **cannot declare an electronic record to be "judicially admissible"**. 

Under established Indian jurisprudence (including *Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal (2020) 7 SCC 1* and its statutory codification in BSA Section 63):
- **Judicial admissibility is an exclusive sovereign function of the presiding judge or magistrate.**
- The trial court alone possesses the judicial authority to evaluate lawful custody, relevance, integrity, credibility, and compliance with statutory filing procedures.
- Any software claim stating "This software certifies legal admissibility" or "Guaranteed admissible in court" is legally inaccurate, misleading, and risks suppression of the evidence under procedural challenge.

### 2.2 Prescribed Technical Attestation Standard
The VigilOne Edge NVR software operates strictly as a **cryptographic integrity attestation engine and unbroken chain-of-custody recorder**. Its evidentiary claims are strictly delimited:

> **System Statutory Wording:**
> *"The system generates a cryptographically verifiable technical integrity attestation and chain-of-custody package. It does not certify legal admissibility or make a judicial determination regarding evidentiary acceptance. Software-generated cryptographic keys and appliance hashes attest to machine-level non-tampering only and STRICTLY DO NOT substitute for statutory human certifications by the lawful custodian or qualified forensic expert. This system does not warrant or guarantee statutory or judicial admissibility; judicial admissibility remains under the exclusive purview of the presiding court."*

---

## 3. System Disclaimers & Provenance Notices

The codebase embeds explicit disclaimers in manifest files and generated PDF certificates:

### 3.1 Appliance Provenance Notice (Machine Signature)
- **Code Symbol:** `BsaCertificatePackageBuilder.PROVENANCE_NOTICE`
- **Text:**
  > *"The appliance Ed25519 digital signature provides a technical attestation of the chronological continuity, system provenance, and immutable media hashes of this export. Statutory Schedule Part A and Part B declarations require independent human execution by authorized personnel. The software does not determine or warrant legal admissibility."*
- **Purpose:** Clarifies that the Ed25519 appliance signature is a machine-level technical integrity attestation, not human statutory testimony.

### 3.2 Manifest Disclaimer (`manifest.json` & PDF Certificate)
- **Code Symbol:** `BsaCertificatePackageBuilder.STATUTORY_DISCLAIMER`
- **Purpose:** Expressly reserves judicial discretion to the court while accurately conveying the cryptographic Merkle tree and SHA-256 technical lineage.

### 3.3 Statutory Schedule PDF Certificate Structure
The generated PDF certificate (`certificate_sec63.pdf`) embedded inside every evidence ZIP archive is partitioned into three distinct sections:
1. **Section 1 (Appliance Technical Provenance & Integrity):** Pre-populated with machine data (Export ID, Appliance ID, Evidence Merkle Root, Dual UTC/Local Timestamps, Custody Chain Head Hash, Derivation Mode, Ed25519 signature snippet). Explicitly marked: *(Automated System Attestation - Verifies Cryptographic Integrity Only; Does Not Certify Legal Admissibility)*.
2. **Section 2 (Schedule Part A - Party In-Charge):** Blank or pre-filled with the designated operator's name and designation, leaving designated blanks for physical signature, date, and official agency seal certifying lawful control and ordinary course of business.
3. **Section 3 (Schedule Part B - Technical Expert):** Structured declaration for the forensic examiner or IT custodian, identifying the Merkle root hash and certifying that the device operated normally without compromise.

---

## 4. Cryptographic Binding Chain & Evidentiary Traceability

The 9-link cryptographic binding chain implemented in VigilOne provides an unbroken mathematical sequence from ingestion to export:

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

### Evidentiary Sequence for Expert Witnesses:
When a designated technical expert or forensic examiner testifies regarding a VigilOne evidence export, the following sequence provides mathematical proof of non-tampering:
1. **Establish Custody:** Present `chain_of_custody.json` demonstrating an unbroken chain of cryptographic hash pointers (`previousEventHash` $\to$ `eventHash`) with zero gaps.
2. **Prove Non-Tampering:** Present the appliance public key (`appliance_public_key.pem`) and demonstrate mathematical verification of `manifest.sig` against canonical `manifest.json`.
3. **Prove Artifact Wholeness:** Recompute SHA-256 of `video.mp4` and `certificate_sec63.pdf`; demonstrate exact match with the `artifacts[]` table in `manifest.json`.
4. **Prove Ingestion Continuity:** Present the Merkle inclusion proofs linking every individual recorded segment to the master Merkle root hash.

---

## 5. Engineering Invariants & Boundaries

1. **Internal Technical Scope Only:** This specification is an engineering blueprint. It does not replace, simulate, or imply legal counsel sign-off.
2. **Mandatory Human Signature:** Electronic evidence packages generated by VigilOne cannot be submitted in court without completed human execution of Schedule Part A and Part B by client-authorized personnel.
3. **Zero Legal Warranties:** VigilOne makes no guarantee of evidentiary acceptance or judicial outcome.
