# Field Technician Standard Operating Procedure (SOP) & Appliance Installation Manual
**Document Reference:** `VIGILONE-SOP-INSTALL-2026-V1`  
**Target Audience:** Certified Field Deployment Technicians, Systems Integrators, On-Site Network Engineers  
**Applicability:** Bare-metal and rackmount VigilOne Edge NVR appliances (Ubuntu 22.04 LTS / 24.04 LTS)  
**Classification:** Operational / Commercial Release Baseline  

---

## 1. Overview & Pre-Installation Readiness

This Standard Operating Procedure (SOP) provides the mandatory, step-by-step installation instructions for deploying a VigilOne Edge NVR appliance at customer premises. Follow all steps in strict sequence. Do not skip or reorder steps.

### 1.1 Required Tooling & Hardware Checklist
Before dispatch to the site, verify possession of:
- [ ] 1x VigilOne certified hardware appliance (or certified bare-metal server).
- [ ] 1x IEC C13 power cable (with dual redundant PDU cables if dual-PSU chassis).
- [ ] 2x Cat6A shielded patch cables (minimum 2 meters, tested).
- [ ] 1x USB 3.0 flash drive containing the offline release bundle (`vigilone-offline-v1.0.0.tar.gz` and `deploy/packaging/install.sh`).
- [ ] 1x Technician laptop equipped with a Gigabit Ethernet port, web browser (Chrome/Firefox), and SSH client.
- [ ] 1x Console cable (RJ45 to USB or VGA + USB keyboard) for out-of-band console access.
- [ ] 1x Tamper-evident credential envelope for customer handover.

---

## 2. Physical & Electrical Setup

### 2.1 Rack Mounting & Airflow
1. Mount the appliance in a standard 19-inch equipment rack using the provided slide rails.
2. Secure the front bezel with four M6 rack screws.
3. Ensure minimum 1RU spacing above and below for optimal front-to-back chassis airflow.
4. Operating temperature environment must be maintained between **10°C and 35°C (50°F to 95°F)** with non-condensing relative humidity below 80%.

### 2.2 Power Connections
1. Connect Power Supply Unit 1 (PSU1) to UPS Circuit A.
2. If dual-PSU model: Connect PSU2 to UPS Circuit B (redundant power feed).
3. Verify that the appliance grounding screw is bonded to the rack ground bus with a 10 AWG green/yellow copper conductor.

---

## 3. Network Architecture & Interface Assignment

The VigilOne appliance mandates strict network isolation between CCTV camera traffic and enterprise client access:

```
[ CCTV Camera Network (VLAN 100) ]
        │ (Unroutable, No Internet)
        ▼
   [ eth1: 192.168.10.10/24 ]
 ┌───────────────────────────────┐
 │   VigilOne Edge Appliance     │
 └───────────────────────────────┘
   [ eth0: 10.0.50.20/24 ]
        ▲
        │ (Protected HTTPS, TLS 1.3)
[ Enterprise Management / Client Network (VLAN 50) ]
```

### 3.1 Interface Configuration via Netplan
Configure static IP assignments on `/etc/netplan/01-vigilone.yaml`:

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    eth0: # Client Management & Viewing Interface
      dhcp4: false
      addresses:
        - 10.0.50.20/24
      routes:
        - to: default
          via: 10.0.50.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
    eth1: # Dedicated Camera VLAN (Isolated, No Gateway)
      dhcp4: false
      addresses:
        - 192.168.10.10/24
```

Apply network settings:
```bash
sudo netplan apply
```
Verify connectivity:
- Ping corporate gateway: `ping -c 3 10.0.50.1`
- Ping test camera on isolated network: `ping -c 3 192.168.10.21`

---

## 4. Storage Pool Partitioning & Initialization

The appliance uses dedicated storage drives for CCTV continuous recording separate from the operating system:
- OS Drive: `/dev/sda` or `/dev/nvme0n1` (OS & PostgreSQL metadata).
- Dedicated Recording Pool: `/dev/sdb` (Surveillance HDD Pool, minimum 4TB).

### 4.1 Storage Verification
Identify storage disks using `lsblk`:
```bash
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS,MODEL
```

> [!CAUTION]
> Ensure the target recording disk is **NOT** the root OS drive (`/`). The installer includes a root wipe guard that immediately aborts if `/dev/sda1` or `/` is selected.

---

## 5. Turnkey Software Installation

Run the turnkey installation script with explicit parameters. For automated unattended deployment:

```bash
cd /opt/vigilone-installer
sudo bash deploy/packaging/install.sh \
  --disk /dev/sdb \
  --lan-ip 10.0.50.20 \
  --force-wipe-disk \
  --non-interactive
```

### 5.1 What the Installer Automates:
1. Validates host architecture (x86_64), available RAM (minimum 8GB), and CPU cores.
2. Enforces root-wipe guard preventing accidental destruction of the OS disk.
3. Formats `/dev/sdb` as ext4 with surveillance performance tuning (`dir_index`, `large_file`).
4. Mounts storage to `/var/lib/vigilone/recordings` and generates persistent `/etc/fstab` entry.
5. Deploys Mount Guard probe token to `/var/lib/vigilone/recordings/.vigilone-mount-probe`.
6. Configures UFW host firewall:
   - Blocks external access to PostgreSQL (5432) and MediaMTX internal API (9997).
   - Opens HTTPS (443), HTTP (80 $\to$ 443 redirect), and WebRTC media UDP (8189).
7. Generates cryptographically strong internal secrets (`JWT_SECRET`, `INTERNAL_API_SECRET`, `ENCRYPTION_KEY`) in `/opt/vigilone/.env` (`0o600`).
8. Generates root-only initial setup token in `/etc/vigilone/setup-token.txt` (`0o600`).
9. Initializes Docker containers and runs automated database migration (`npx prisma migrate deploy`).
10. Executes automated 45-second healthcheck probe verifying backend readiness.

---

## 6. Post-Installation Verification & Handover Token

After `install.sh` completes with exit code 0:
1. Verify system status:
   ```bash
   vigilonectl status
   ```
   Confirm all containers (`vigilone-caddy`, `vigilone-backend`, `vigilone-mediamtx`, `vigilone-postgres`) report `Up (healthy)`.
2. Retrieve the initial setup token:
   ```bash
   vigilonectl token
   ```
   The terminal will output a secure 32-character hexadecimal Setup PIN:
   ```text
   ================================================================================
     VigilOne Initial Setup PIN: 4a9f2c8d1e3b5a7098e4f1c2d3e4b5a6
   ================================================================================
   ```
3. Connect laptop to the management network, open Chrome or Firefox, and navigate to:
   `https://10.0.50.20`
4. Enter the Setup PIN to access the first-run configuration wizard.
5. Create the initial administrative account and configure camera RTSP feeds.
6. Seal the Setup PIN and administrative credentials in the tamper-evident envelope for formal handover to the customer.
