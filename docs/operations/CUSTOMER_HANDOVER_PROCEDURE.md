# Commercial Customer Handover Procedure & Operational Commissioning Protocol
**Document Reference:** `VIGILONE-SOP-HANDOVER-2026-V1`  
**Site Identifier:** ____________________________________________________  
**Customer Organization:** ______________________________________________  
**Appliance Model & Serial:** ___________________________________________  
**Target Completion Date:** _____________________________________________  

---

## 1. Handover Governance & Security Principle

The commercial handover procedure marks the formal boundary where operational ownership transitions from the deployment engineering team to the customer's authorized IT/Security personnel.

> [!IMPORTANT]
> **Strict Custodial Invariant:**
> VigilOne deployment engineers and field technicians must **never retain root access, administrative passwords, or unsealed credentials** following site sign-off. The appliance must be delivered into the sole, exclusive custody of the customer's designated administrator.

---

## 2. Step-by-Step Handover Protocol

### Step 1: Verification of Commissioning Checklist
Prior to scheduling the handover meeting:
1. Ensure all 30 points of the [Installation Acceptance Checklist](./INSTALLATION_ACCEPTANCE_CHECKLIST.md) are completed and signed.
2. Confirm all live camera feeds are recording continuously without dropped segments.
3. Verify that the appliance storage pool is mounted, healthy, and reporting correct capacity in `vigilonectl status`.

### Step 2: Technician Setup PIN Handover & Initial Bootstrap
1. The field technician opens the physical tamper-evident credential envelope in the presence of the customer's designated system administrator.
2. The technician navigates to the appliance URL in the browser:
   `https://<appliance-lan-ip>`
3. The customer administrator types the single-use Setup PIN (obtained from `vigilonectl token`).
4. The web wizard prompts the administrator to create the **Master Administrator Account**:
   - Master Admin Username
   - Master Admin Email
   - Strong Master Password (minimum 12 characters, uppercase, lowercase, numbers, symbols)
5. Upon successful creation, the backend permanently disables the `/api/v1/auth/bootstrap` route (returns `410 Gone`), locking the bootstrap mechanism forever.

### Step 3: Appliance Host & Root Password Sealing
1. If host SSH access is provisioned, the customer administrator enters their chosen Linux host root password directly on the console.
2. The technician verifies that SSH password authentication is disabled and only key-based authentication is permitted (or local physical console access only).
3. Any physical emergency recovery credentials are sealed inside a fresh tamper-evident serialized envelope (Envelope Serial Number: `____________________`).
4. The sealed envelope is handed directly to the customer's Chief Information Security Officer (CISO) or designated custodian.

---

## 3. Customer Administrator Training Syllabus

The field engineer conducts a mandatory 45-minute operational walkthrough covering four core workflows:

1. **Live Multi-Camera Monitoring:**
   - Grid layouts (1x1, 2x2, 3x3, 4x4, 8x8).
   - Switching between Main Stream (4K/1080p for full-screen) and Sub Stream (D1/720p for multi-camera grids).
   - PTZ controls and preset positioning (if PTZ cameras deployed).
2. **Timeline Playback & Forensic Seek:**
   - Timeline color coding: Continuous recording (blue), Motion/Alarm intervals (yellow), Pinned evidence (red).
   - Synchronized multi-camera playback seek.
   - Variable playback speeds (0.5x, 1x, 2x, 4x, 8x, 16x).
3. **Section 63 BSA Forensic Evidence Export:**
   - Selecting camera, start time, end time, and export mode (`STREAM_COPY` vs `FRAME_ACCURATE`).
   - Entering Schedule Part A (Party in-charge) and Part B (Technical Expert) details.
   - Downloading the structured `Evidence_<ID>.zip` package.
   - Inspecting the generated `certificate_sec63.pdf` and verifying the detached `manifest.sig`.
4. **Appliance Management via Web UI & CLI:**
   - Viewing system vitals and storage alarms.
   - Generating a sanitized diagnostic bundle using `vigilonectl support-bundle`.
   - Creating an on-demand database backup using `vigilonectl backup create`.

---

## 4. Formal Handover Sign-Off Form

By signing below, the customer acknowledges receipt of the appliance in fully operational condition, confirms completion of administrator training, and accepts exclusive operational custody of all system credentials:

### Customer Acknowledgements:
- [ ] Initial bootstrap PIN utilized; Master Administrator account created by customer.
- [ ] Bootstrap route verified permanently locked (`410 Gone`).
- [ ] All deployment technicians have relinquished administrative access.
- [ ] Sealed emergency credential envelope received intact.
- [ ] Section 63 BSA evidence export procedure demonstrated and witnessed.
- [ ] Operational manuals, SLA contacts, and escalation matrices received.

| Party | Name & Title | Signature | Date & Time |
|---|---|---|---|
| **Deploying Lead Engineer** | ____________________________ | ____________________________ | ____________________ |
| **Customer Lead Administrator** | ____________________________ | ____________________________ | ____________________ |
| **Customer IT / Security Director** | ____________________________ | ____________________________ | ____________________ |
