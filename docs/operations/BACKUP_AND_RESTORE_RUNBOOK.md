# Operational Backup, Cold Storage & Disaster Recovery Runbook
**Document Reference:** `VIGILONE-OPS-BACKUP-2026-V1`  
**Applicability:** Production VigilOne Edge NVR Appliances  
**Prerequisites:** Root or sudo access; familiarity with `vigilonectl` management CLI  

---

## 1. Overview & Architectural Principles

The VigilOne backup and disaster recovery architecture is designed to protect both relational metadata (cameras, users, segments, retention policies, legal pins) and immutable security floors (monotonic clock floor, license revocations, OTA release epoch).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Appliance Host State                            │
│                                                                        │
│  [ PostgreSQL Database ]         [ Host Security State (/etc/vigilone) ]
│  - Cameras, Users, Tenants       - clock_guard.state (Floor: 0o600)    │
│  - Recording Segment Index       - ota_release.state (Epoch: 0o600)    │
│  - Chain of Custody Logs         - pinned_segments.state (Pins: 0o600) │
│  - Evidence Manifests            - license.json (Commercial License)   │
└────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **Monotonic Security Preservation Invariant:**
> Neither cold backup restoration nor catastrophic rebuild can ever regress the **4-Pillar Monotonic Security Stack**:
> 1. *Clock Floor:* `ClockGuard.lastKnownGoodTime` in `/etc/vigilone/clock_guard.state`.
> 2. *License Revocation Floor:* Revoked license IDs in SQLite/Postgres union set.
> 3. *Trust-Anchor Floor:* Embedded vendor keys with domain separation.
> 4. *OTA Release Floor:* `highestAcceptedOtaEpoch` in `/etc/vigilone/ota_release.state`.

---

## 2. Creating an Appliance Backup Archive

Backups can be generated on-demand or automated via cron:

```bash
sudo vigilonectl backup create [target_archive_path]
```

### 2.1 Default Storage Location:
If no path is specified, the archive is saved to:
`/var/lib/vigilone/backups/vigilone-backup-YYYYMMDDHHmmss.tar.gz`

### 2.2 What is Included in the Backup:
1. Full PostgreSQL database dump (`database.sql`) via `pg_dump`.
2. Host configuration directory tree (`/etc/vigilone/*`):
   - Setup token
   - ClockGuard state
   - OTA release state
   - Pinned segments state mirror
   - Commercial license file
3. Environment secrets configuration (`/opt/vigilone/.env`).
4. Automated backup manifest (`backup_manifest.json`) containing cryptographic SHA-256 hashes of all components.

### 2.3 Automating Daily Backups (Cron Example):
Add to root crontab (`sudo crontab -e`):
```cron
# Daily atomic VigilOne backup at 02:00 AM
0 2 * * * /usr/local/bin/vigilonectl backup create /mnt/nfs_backup/vigilone-daily-$(date +\%Y\%m\%d).tar.gz >> /var/log/vigilone-backup.log 2>&1
```

---

## 3. Disaster Recovery Procedures

### Procedure A: Cold Backup Restoration (Database & State Recovery)
Use this procedure when restoring an appliance to a previous known-good backup state (e.g., following administrative misconfiguration or software error):

1. **Locate Backup Archive:**
   Ensure the backup file (e.g. `/mnt/backup/vigilone-backup-20260910.tar.gz`) is accessible on the host.
2. **Execute Atomic Restore:**
   ```bash
   sudo vigilonectl backup restore /mnt/backup/vigilone-backup-20260910.tar.gz
   ```
3. **What the Restore Executes Automatically:**
   - Shuts down application containers (`caddy`, `backend`, `mediamtx`).
   - Restores PostgreSQL database from `database.sql`.
   - Restores `/etc/vigilone/` configuration tree.
   - **Enforces Monotonic Safety:** Computes the mathematical maximum of current host clock floor vs backup clock floor; preserves current `highestAcceptedOtaEpoch` and revoked license IDs.
   - Restarts Docker compose services and waits for healthchecks to pass.
4. **Post-Restore Verification:**
   ```bash
   vigilonectl status
   ```

---

### Procedure B: Catastrophic Bare-Metal Database Loss & Storage Rebuild
Use this procedure when the PostgreSQL database is entirely corrupted, deleted, or missing, but existing video files remain on the recording drive (`/var/lib/vigilone/recordings`):

1. **Initialize Fresh Database Container:**
   ```bash
   cd /opt/vigilone
   docker compose down
   docker compose up -d postgres
   docker compose run --rm backend npx prisma migrate deploy
   ```
2. **Trigger Disaster Recovery Service Reconciliation:**
   The backend's `DisasterRecoveryService` automatically initiates upon boot or via CLI:
   ```bash
   docker compose exec -T backend npx ts-node -e "
     import { DisasterRecoveryService } from './src/services/appliance/disasterRecovery.service';
     import prisma from './src/config/database';
     const dr = new DisasterRecoveryService(prisma);
     dr.rebuildFromStorageAndHostMirror({
       recordingsDir: '/var/lib/vigilone/recordings',
       hostStateDir: '/etc/vigilone'
     }).then(res => console.log('Rebuild Complete:', res));
   "
   ```
3. **What Procedure B Performs:**
   - **Admit Mapped Media:** Scans `/var/lib/vigilone/recordings/` for camera folders; parses filename timestamps; computes streaming SHA-256; re-indexes valid segments into the new database.
   - **Restore Legal Hold Pins:** Reads `/etc/vigilone/pinned_segments.state` (host mirror); restores all active `LEGAL_HOLD` pins into the newly recreated `EvidencePin` table.
   - **Quarantine Unmapped Media:** Any orphaned segments that cannot be mapped to a known camera are safely relocated to `/var/lib/vigilone/recordings/.quarantine` with strict 5% storage accounting (pinned evidence is never pruned).
   - **Auditable Custody Demarcation:** Records an authoritative custodial event in `CustodyLedger`:
     `Custody history before bare-metal rebuild is not recoverable; media integrity re-anchored at <date>`.
   - **Auto-Restores License:** Reads `/etc/vigilone/license.json` and synchronizes the active commercial license into the database.
4. **Verify Recovery:**
   Log in to the Web UI, verify that the camera timeline displays historical recording segments, and verify that legal holds remain pinned.
