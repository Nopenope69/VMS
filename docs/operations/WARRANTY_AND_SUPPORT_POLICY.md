# Commercial Warranty, Software Maintenance & SLA Support Policy
**Document Reference:** `VIGILONE-POL-WARRANTY-2026-V1`  
**Applicability:** Commercial VigilOne Edge NVR Appliances & Enterprise Subscriptions  
**Effective Date:** September 13, 2026  
**Review Cycle:** Annual  

---

## 1. Hardware Appliance Warranty

### 1.1 Standard Hardware Warranty (3-Year Advance Replacement)
All factory-certified VigilOne Edge NVR appliances include a **3-Year Limited Hardware Warranty** from the date of initial commercial delivery:
1. **Component Coverage:** Motherboard, CPU, ECC RAM, redundant power supplies (PSUs), hardware cooling fans, internal backplanes, and factory-provisioned NVMe boot drives are covered against manufacturing and component defects.
2. **Surveillance Hard Drives:** Factory-installed Western Digital Purple Pro or Seagate SkyHawk AI surveillance drives carry a 3-year manufacturer pass-through warranty.
3. **Advance Hardware Replacement (RMA):** Following confirmation of hardware component failure by VigilOne Tier 2 Technical Support, a replacement part or replacement appliance chassis is dispatched via express courier within 24 business hours prior to return of the defective unit.

### 1.2 Exclusions from Hardware Warranty
The hardware warranty does **not** cover:
- Damage resulting from improper facility electrical supply, lightning strikes, power surges without surge suppression, or improper earthing/grounding.
- Water damage, chemical contamination, or operating outside ambient operating temperature envelopes (10°C to 35°C).
- Third-party hard drives installed by the customer without factory certification.
- Physical damage, chassis drop, or unauthorized physical tampering with internal circuitry.

---

## 2. Software Subscription & Maintenance Policy

### 2.1 Continuous Updates & Security Patches
Every active VigilOne commercial software subscription grants entitlement to:
1. **Signed Cryptographic OTA Updates:** Automated access to minor releases, kernel security patches, and application enhancements signed by `VENDOR_OTA_PUBLIC_KEY`.
2. **Monotonic Release Protection:** Guaranteed upgrade paths with persistent monotonic epoch floors preventing software downgrades or rollback tampering.
3. **Database Migration Continuity:** Zero-loss automated Prisma database migrations applied safely upon container startup.
4. **Disaster Recovery Support:** Support for cold database restoration and automated orphan media reconciliation.

### 2.2 Release Support Lifecycle
- **Active Support:** Current release branch receives regular monthly maintenance and security rollups.
- **Maintenance Support:** Prior minor release supported for 6 months post-superseding release.
- **End-of-Life (EOL):** Software releases older than 12 months are retired; customers are assisted in upgrading via OTA to the active baseline.

---

## 3. SLA Support Tiers & Response Matrices

VigilOne provides three formal Technical Support Service Level Agreement (SLA) tiers:

| Metric | Platinum (Critical Enterprise) | Gold (Business Priority) | Silver (Standard Commercial) |
|---|---|---|---|
| **Coverage Hours** | 24 hours / 7 days / 365 days | 08:00 - 20:00 (Local Time), 6 Days | 09:00 - 18:00 (Mon - Fri) |
| **Severity 1 Initial Response** | $\le \mathbf{1\text{ hour}}$ | $\le \mathbf{2\text{ hours}}$ | $\le \mathbf{4\text{ hours}}$ |
| **Severity 1 Target MTTR** | $\le \mathbf{4\text{ hours}}$ | $\le \mathbf{8\text{ hours}}$ | Next Business Day |
| **Severity 2 Initial Response** | $\le 2\text{ hours}$ | $\le 4\text{ hours}$ | $\le 8\text{ hours}$ |
| **Severity 3 Initial Response** | $\le 8\text{ hours}$ | Next Business Day | 2 Business Days |
| **RMA Hardware Dispatch** | Same Day (if before 14:00) | Next Business Day | 2 Business Days |
| **Dedicated TAM** | Designated Technical Account Mgr | Shared Support Pool | Support Ticketing Portal |

### Severity Incident Definitions:
- **Severity 1 (Critical Outage):** Total inability to record CCTV streams, complete appliance boot failure, Mount Guard critical storage lockout, or unrecoverable system crash affecting all cameras.
- **Severity 2 (Degraded Operation):** Failure of an individual camera stream, storage volume degradation with healthy fallback active, or inability to export evidence clips while recording continues.
- **Severity 3 (Minor Defect / Inquiry):** Web UI visual cosmetic issue, minor documentation ambiguity, or non-blocking configuration query.

---

## 4. Operational Boundaries & Demarcation

To avoid operational ambiguity between vendor and customer engineering teams:

### What VigilOne Supports:
- The VigilOne NVR application stack (Caddy gateway, MediaMTX engine, Node/Express backend, PostgreSQL database).
- Linux host operating system configuration deployed by `install.sh`.
- Automated evidence export, Merkle tree calculation, Section 63 BSA certificate generation, and Ed25519 signing.
- Disaster recovery procedures and OTA updates.

### What is Excluded (Customer / Integrator Responsibility):
- Third-party camera hardware defects, camera lens focus, physical camera vandalization, or camera firmware bugs.
- Site structural cabling, patch panels, fiber uplinks, and building PoE power delivery.
- Customer-managed corporate routers, firewalls, and active directory infrastructure.
- Direct root operating system modifications executed outside the provided `vigilonectl` management CLI.
