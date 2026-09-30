# Go-live runbook

This runbook takes one site from a delivered appliance to a live system that real people rely on. Every step
names who does it, the command or document, and what "done" means. The software checks what it can:
`vigilonectl golive` exits non-zero while anything blocks. The rest are named sign-offs.

**Status:**
* `vigilonectl golive` and the hardened `vigilonectl backup` are tested:
  * `goLiveCheck.test.ts` checks every go-live rule and runs the check against a real database;
  * `backup-restore.test.sh` runs a real PostgreSQL round trip and every failure path.
* **No site has gone live yet.** This runbook has not been used on a real deployment. Expect to amend it
  after the first pilot.

## 0. Before the visit (office)

| Step | Who | Done when |
| --- | --- | --- |
| Site survey: camera list, network plan, storage sizing, power, UPS | Field engineer | Survey sheet signed by the customer |
| Licence approvals for every AI model the site will use (`scripts/models/model-license-exceptions.json`) | **Owner** | An approval entry exists for each model; none is TEST-ONLY |
| DPDP decision record prepared for this site (`DPDP_DECISION_RECORD.md`) | Owner and the customer's data fiduciary | Signed |
| Customer certificate or DNS name for TLS | Customer IT | Certificate files or a DNS name in hand |
| Identity provider registration, only if SSO is used (`SSO.md`) | Customer IT | Client id, secret and redirect URI registered |

## 1. Install

1. Rack, power and cable the appliance; follow `TECHNICIAN_SOP_AND_INSTALLATION_MANUAL.md`.
2. Run `sudo ./install.sh`. Its pre-flight checks the CPU, RAM, disk and ports; it generates the secrets and
   installs `vigilonectl`.
3. Complete first-run setup in the browser with the setup token (`vigilonectl token`), then destroy the token.
4. Set the clock source: NTP must be synchronised (`timedatectl`).

## 2. Configure

1. Add the cameras. Set continuous recording where the site requires it.
2. Turn on only the features this site bought and has validated (`FEATURE_FLAGS.md`). Every feature that was
   tested only against a simulator shows as a WARN in the go-live check until the site validation is done:

| Feature | Site validation to do before relying on it |
| --- | --- |
| Door relays and contacts (`DIO_RELAY`) | For each door: unlock from VigilOne, then check `OPENED`; open without an unlock, then check `FORCED_OPEN`; hold it open, then check `HELD_OPEN` |
| SSO (`OIDC_SSO`) | One real sign-in per role; check the role mapping |
| Off-site archive (`OBJECT_STORAGE_ARCHIVE`) | Upload and read back one segment from the customer bucket |
| ANPR, redaction | Review a sample of plate reads and one redacted export |

3. With several backend nodes: set `VIGILONE_HA_NODE_ID` on each (`HIGH_AVAILABILITY.md`). The database and
   the recordings are still single points of failure.

## 3. Prove it

| Step | Command | Done when |
| --- | --- | --- |
| Installation acceptance | `sudo vigilonectl acceptance` | Every automated item passes; the field engineer signs each MANUAL item |
| Backup | `sudo vigilonectl backup create /mnt/backup/golive.tar.gz` | Command exits 0 |
| Restore drill | `sudo vigilonectl backup restore /mnt/backup/golive.tar.gz`, **on a spare machine** | Exits 0; the spare shows the cameras and users; `vigilonectl golive` there shows no BLOCK beyond expected recording gaps |
| Evidence export and verification | Export one clip; run `vigilone-verify` on it (`EVIDENCE_VERIFICATION.md`) | The verifier reports the package intact |
| Go-live check | `sudo vigilonectl golive` | Exit 0: no BLOCK; each WARN accepted in writing by the customer |

What `vigilonectl golive` checks:

**BLOCK** (must be fixed):
* not in production mode;
* a placeholder, development or short JWT secret;
* the published development credential key;
* SSO on without an https `VIGILONE_PUBLIC_URL`;
* a failed migration;
* setup not completed;
* a broken audit chain;
* a continuously recording camera with no finished segment in 30 minutes;
* under 5% free disk;
* an unsynchronised clock;
* TEST-ONLY model approvals.

**WARN** (someone must accept it):
* 5% to 15% free disk;
* no cameras;
* a backup-server setup where no node holds the lease;
* every enabled feature that still needs site validation.

**MANUAL** (a named person signs it off):
* the acceptance checklist;
* the DPDP record;
* the backup and restore drill;
* the TLS certificate;
* the customer handover.

## 4. Supervised pilot

Run supervised for an agreed period (the North Star V0.1 gate proposes 72 hours on 16 to 32 cameras):
* an operator watches alarms and marks false alarms;
* recording gaps are reviewed each day (`vigilonectl status`, the recording watchdog);
* `vigilonectl golive` runs each day and any new BLOCK is fixed the same day.

## 5. Handover and go-live

Follow `CUSTOMER_HANDOVER_PROCEDURE.md`:
* administrator credentials change hands;
* support contacts and the escalation path are agreed (`SUPPORT_ESCALATION_PROCEDURE.md`);
* the nightly backup cron is in place and alerts on failure.

Record the go-live date and the `vigilonectl golive --json` report in the site file.

## Rollback

* **Software:** `vigilonectl ota rollback` returns to the previous signed release; the anti-rollback floor still
  applies.
* **Data:** `vigilonectl backup restore <last good archive>`. It runs in one transaction, so a failed restore
  changes nothing.
* **Feature:** turn its flag off and restart. The data it wrote stays.
