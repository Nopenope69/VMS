# Technical Support Escalation Procedure & Triage Hierarchy
**Document Reference:** `VIGILONE-SOP-ESCALATE-2026-V1`  
**Applicability:** Customer Technical Teams, Certified Field Integrators, VigilOne Global Support  
**Release Target:** v1.0.0 Commercial Release Baseline  

---

## 1. Support Triage Hierarchy & Escalation Flow

```
[ Customer / On-Site Operator ]
               │
               ▼
[ Tier 1: Certified Systems Integrator / Helpdesk ]
   - Initial triage, physical cabling check, camera power cycling
   - Runs 'vigilonectl status' and checks Web UI alarms
               │
               ▼ (Unresolved in 30 mins for Sev 1 / 2 hrs for Sev 2)
[ Tier 2: VigilOne Technical Support Engineering ]
   - Deep log analysis, storage volume recovery, database inspection
   - Requests sanitized diagnostic bundle via 'vigilonectl support-bundle'
   - Executes remote diagnostic commands through vigilonectl
               │
               ▼ (Unresolved in 2 hrs for Sev 1 / Software Bug Confirmed)
[ Tier 3: VigilOne Core Systems & Security Engineering ]
   - Kernel / media pipeline triage, MediaMTX engine debugging
   - Hotfix / emergency signed OTA patch creation
   - Direct engagement with Customer Head of IT
```

---

## 2. Generating a Sanitized Diagnostics Support Bundle

To comply with customer privacy standards, data protection laws, and contract security requirements, customer technicians must **never** send raw configuration files or unredacted database dumps to technical support.

VigilOne provides an automated, privacy-sanitizing diagnostics generator embedded in the management CLI:

```bash
sudo vigilonectl support-bundle [output_archive_path]
```

### 2.1 What the Support Bundle Collects:
1. **System Vitals:** `uname -a`, Linux kernel version, `os-release`, CPU load averages, and memory utilization.
2. **Storage Vitals:** Partition tables (`lsblk`), disk utilization (`df -h`), Mount Guard probe token presence, and filesystem mount options.
3. **Container State:** Status, healthchecks, and uptime of all Docker compose stack containers.
4. **Service Logs:** Last 500 lines of application logs from Caddy, backend, MediaMTX, and PostgreSQL.

### 2.2 Automated Privacy & Security Sanitization Filter:
The `vigilonectl support-bundle` command automatically runs an in-line cryptographic sanitization filter before generating the compressed archive:
- Strips JSON Web Tokens (`JWT`): Matches `eyJ...` patterns and replaces with `[SANITIZED_JWT]`.
- Strips Bearer authorization headers: Replaces with `Bearer [SANITIZED_TOKEN]`.
- Strips Database Connection Strings: Replaces PostgreSQL credentials with `postgresql://:[SANITIZED]@...`.
- Strips RTSP Camera Credentials: Replaces camera passwords in URLs with `rtsp://:[SANITIZED]@...`.
- Strips Internal Secrets: Redacts `SETUP_TOKEN`, `JWT_SECRET`, `INTERNAL_API_SECRET`, `POSTGRES_PASSWORD`, `COTURN_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY`.

### 2.3 Uploading the Bundle:
Once generated (e.g. `/tmp/vigilone-support-20260913-103000.tar.gz`), transmit the archive to VigilOne Enterprise Support:
- Portal: `https://support.vigilone.com/tickets/upload`
- Email: `support-escalations@vigilone.com` (Reference Ticket ID in Subject)

---

## 3. Emergency Incident Escalation Runbook (Severity 1)

For Severity 1 incidents (e.g., active footage recording stopped across all channels):

1. **Immediate On-Site Verification (Field Tech):**
   ```bash
   # Check overall appliance status
   vigilonectl status
   
   # Inspect active container logs for fatal exceptions
   vigilonectl logs --tail=100
   ```
2. **Check Mount Guard & Storage Health:**
   ```bash
   ls -la /var/lib/vigilone/recordings/.vigilone-mount-probe
   ```
   If Mount Guard has tripped due to disk full (100%) or filesystem EROFS:
   - Verify disk health via `dmesg | grep -i -E "error|ata|scsi|nvme"`.
   - If secondary volume exists, verify automatic fallback routing in logs.
3. **Safe Restart Attempt:**
   ```bash
   vigilonectl restart
   ```
   Check if services re-enter `healthy` status within 45 seconds.
4. **Trigger Tier 2 Hotline:**
   Call the dedicated 24/7 Enterprise Platinum hotline (+91 800-VIGIL-911) with:
   - Appliance Serial Number
   - Site Name & IP Address
   - Output of `vigilonectl status`
   - Generated `vigilone-support-*.tar.gz` bundle
