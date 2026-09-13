#!/usr/bin/env bash
# ==============================================================================
# VigilOne VMS - Commercial Turnkey Appliance Installer
# Supported OS: Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12 (AMD64 / x86_64)
# ==============================================================================

set -euo pipefail

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
NC="\033[0m" # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALL_DIR="/opt/vigilone"
CONFIG_DIR="/etc/vigilone"
DATA_DIR="/var/lib/vigilone"
RECORDINGS_DIR="${DATA_DIR}/recordings"
POSTGRES_DIR="${DATA_DIR}/postgres"
LOG_DIR="/var/log/vigilone"

UNATTENDED=false
TARGET_DISK=""
FORCE_WIPE=false
CUSTOM_LAN_IP=""
OFFLINE_BUNDLE=""


print_banner() {
    echo -e "${BLUE}"
    echo "================================================================================"
    echo "        VigilOne VMS — Commercial Edge Surveillance Appliance Installer         "
    echo "================================================================================"
    echo -e "${NC}"
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_err() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

fatal() {
    log_err "$1"
    exit 1
}

# ------------------------------------------------------------------------------
# 1. Parse Command-Line Arguments
# ------------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --unattended|-y|--non-interactive)
            UNATTENDED=true
            shift
            ;;
        --disk|-d)
            TARGET_DISK="$2"
            shift 2
            ;;
        --force-wipe-disk)
            FORCE_WIPE=true
            shift
            ;;
        --lan-ip)
            CUSTOM_LAN_IP="$2"
            shift 2
            ;;
        --offline-bundle)
            OFFLINE_BUNDLE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: sudo ./install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --unattended, -y, --non-interactive  Run without interactive prompts"
            echo "  --disk <path>                        Dedicated block device for CCTV storage (e.g. /dev/sdb)"
            echo "  --force-wipe-disk                    Allow wiping disk with existing partitions in unattended mode"
            echo "  --lan-ip <ip>                        Manually specify primary LAN IP address"
            echo "  --offline-bundle <path>              Path to pre-exported docker images tarball (air-gapped)"
            echo "  --help, -h                           Show this help menu"
            exit 0
            ;;
        *)
            fatal "Unknown option: $1. Run with --help for usage."
            ;;
    esac
done

# ------------------------------------------------------------------------------
# 2. Hardware & Pre-flight Checks (Tier 1 AMD64 Baseline)
# ------------------------------------------------------------------------------
preflight_checks() {
    log_info "Executing hardware and operating system pre-flight checks..."

    # Check root privileges
    if [[ "$(id -u)" -ne 0 ]]; then
        fatal "This installer must be run as root (use: sudo ./install.sh)."
    fi

    # Architecture verification
    ARCH="$(uname -m)"
    if [[ "$ARCH" != "x86_64" ]]; then
        if [[ "$ARCH" == "aarch64" ]]; then
            log_warn "ARM64 architecture detected ($ARCH). ARM64 is Tier 2 hardware; AMD64 is recommended for production."
        else
            fatal "Unsupported CPU architecture: $ARCH. VigilOne requires AMD64 (x86_64) or ARM64 (aarch64)."
        fi
    fi

    # RAM verification
    TOTAL_RAM_KB="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 8388608)"
    TOTAL_RAM_MB="$((TOTAL_RAM_KB / 1024))"
    log_info "Detected System RAM: ${TOTAL_RAM_MB} MB"

    if [[ "$TOTAL_RAM_MB" -lt 3800 ]]; then
        log_warn "Appliance has less than 4 GB of RAM (${TOTAL_RAM_MB} MB). Multi-camera performance will be degraded."
    fi

    # Swap file check: if RAM < 8GB and swap < 2GB, configure 4GB swap to prevent camera OOM killer panics
    SWAP_TOTAL_KB="$(grep SwapTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 2097152)"
    if [[ "$TOTAL_RAM_MB" -lt 7800 && "$SWAP_TOTAL_KB" -lt 2000000 ]]; then
        log_info "System RAM is under 8 GB. Provisioning 4 GB emergency swapfile at /swapfile-vigilone..."
        if [[ ! -f /swapfile-vigilone ]]; then
            fallocate -l 4G /swapfile-vigilone 2>/dev/null || dd if=/dev/zero of=/swapfile-vigilone bs=1M count=4096 status=none 2>/dev/null || true
            chmod 600 /swapfile-vigilone 2>/dev/null || true
            mkswap /swapfile-vigilone 2>/dev/null || true
            swapon /swapfile-vigilone 2>/dev/null || true
            if [[ -f /etc/fstab ]] && ! grep -q '/swapfile-vigilone' /etc/fstab; then
                echo "/swapfile-vigilone none swap sw 0 0" >> /etc/fstab
            fi
            log_info "4 GB swapfile provisioned and registered in /etc/fstab."
        fi
    fi

    # Port conflict checks (ports 80, 443, 8189 must be available)
    for port in 80 443; do
        if command -v ss &>/dev/null; then
            if ss -tuln | grep -q ":${port} "; then
                log_warn "Port ${port} appears to be in use. Caddy may fail to bind unless existing service is stopped."
            fi
        fi
    done
}

# ------------------------------------------------------------------------------
# 3. Dedicated CCTV Storage Partitioning & Mount Guard Safeguards
# ------------------------------------------------------------------------------
provision_storage_disk() {
    if [[ -z "$TARGET_DISK" ]]; then
        log_info "No dedicated disk specified via --disk. Using default root storage at ${RECORDINGS_DIR}."
        mkdir -p "${RECORDINGS_DIR}"
        return 0
    fi

    log_info "Evaluating dedicated CCTV storage disk candidate: ${TARGET_DISK}..."

    # 1. Verify block device exists
    if [[ ! -b "$TARGET_DISK" ]]; then
        fatal "Target disk ${TARGET_DISK} is not a valid block device!"
    fi

    # 2. Prevent formatting root OS disk
    ROOT_DEV="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
    if [[ -n "$ROOT_DEV" ]]; then
        ROOT_PARENT="$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null || true)"
        TARGET_NAME="$(basename "$TARGET_DISK")"
        if [[ "$ROOT_DEV" == *"$TARGET_NAME"* || ( -n "$ROOT_PARENT" && "$TARGET_NAME" == "$ROOT_PARENT" ) ]]; then
            fatal "REFUSING TO FORMAT: ${TARGET_DISK} hosts the operating system root filesystem (/)!"
        fi
    fi

    # 3. Prevent formatting currently mounted devices
    MOUNTED_POINTS="$(lsblk -no MOUNTPOINTS "$TARGET_DISK" 2>/dev/null | grep -v '^$' || true)"
    if [[ -n "$MOUNTED_POINTS" ]]; then
        if [[ "$MOUNTED_POINTS" == *"${RECORDINGS_DIR}"* ]]; then
            log_info "${TARGET_DISK} is already mounted to ${RECORDINGS_DIR}. Preserving existing partition."
            return 0
        else
            fatal "REFUSING TO FORMAT: ${TARGET_DISK} contains active mount points: ${MOUNTED_POINTS}."
        fi
    fi

    # 4. Check if existing VigilOne filesystem is already present
    TEMP_PROBE="/tmp/vigilone_probe_mount"
    mkdir -p "$TEMP_PROBE"
    if mount "$TARGET_DISK" "$TEMP_PROBE" 2>/dev/null; then
        if [[ -f "${TEMP_PROBE}/.vigilone-mount-probe" ]]; then
            log_info "Existing VigilOne CCTV volume recognized on ${TARGET_DISK}. Re-using without re-formatting."
            umount "$TEMP_PROBE" 2>/dev/null || true
            rmdir "$TEMP_PROBE" 2>/dev/null || true
            mount_and_persist_disk "$TARGET_DISK"
            return 0
        fi
        umount "$TEMP_PROBE" 2>/dev/null || true
    fi
    rmdir "$TEMP_PROBE" 2>/dev/null || true

    # 5. Partition table safeguard
    PART_COUNT="$(lsblk -no TYPE "$TARGET_DISK" 2>/dev/null | grep -c 'part' || true)"
    if [[ "$PART_COUNT" -gt 0 && "$FORCE_WIPE" != "true" && "$UNATTENDED" == "true" ]]; then
        fatal "Target disk ${TARGET_DISK} has existing partitions. Unattended mode refuses to wipe without --force-wipe-disk."
    fi

    # 6. Interactive confirmation if not unattended
    if [[ "$UNATTENDED" != "true" ]]; then
        echo -e "${RED}"
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        echo "WARNING: All data on ${TARGET_DISK} will be permanently erased!"
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        echo -e "${NC}"
        read -r -p "Type '$(basename "$TARGET_DISK")' to confirm destructive formatting: " CONFIRM_DISK
        if [[ "$CONFIRM_DISK" != "$(basename "$TARGET_DISK")" ]]; then
            fatal "Formatting cancelled by user."
        fi
    fi

    log_info "Formatting ${TARGET_DISK} with ext4 CCTV write-optimized settings..."
    mkfs.ext4 -F -O mmp -m 1 -E lazy_itable_init=0,lazy_journal_init=0 "${TARGET_DISK}"

    mount_and_persist_disk "${TARGET_DISK}"
}

mount_and_persist_disk() {
    local disk="$1"
    mkdir -p "${RECORDINGS_DIR}"

    DISK_UUID="$(blkid -s UUID -o value "$disk" 2>/dev/null || true)"
    if [[ -z "$DISK_UUID" ]]; then
        fatal "Unable to retrieve UUID for ${disk}."
    fi

    # Mount disk with CCTV optimizations
    log_info "Mounting UUID=${DISK_UUID} to ${RECORDINGS_DIR} with noatime,nodiratime..."
    if [[ -f /etc/fstab ]] && ! grep -q "${DISK_UUID}" /etc/fstab; then
        echo "UUID=${DISK_UUID} ${RECORDINGS_DIR} ext4 defaults,noatime,nodiratime,nofail 0 2" >> /etc/fstab
    fi

    if ! mount -a 2>/dev/null && ! mount "${disk}" "${RECORDINGS_DIR}" 2>/dev/null; then
        fatal "Failed to mount target storage disk ${disk} to ${RECORDINGS_DIR}!"
    fi
    log_info "Disk successfully mounted and registered in /etc/fstab."
}

# ------------------------------------------------------------------------------
# 4. Host Directories & Mount Guard Initialization
# ------------------------------------------------------------------------------
init_directories_and_mountguard() {
    log_info "Initializing directory structure and Mount Guard..."

    mkdir -p "${INSTALL_DIR}"
    mkdir -p "${CONFIG_DIR}"
    chmod 700 "${CONFIG_DIR}" 2>/dev/null || true
    mkdir -p "${CONFIG_DIR}/ssl"
    mkdir -p "${DATA_DIR}"
    mkdir -p "${RECORDINGS_DIR}"
    mkdir -p "${RECORDINGS_DIR}/exports"
    mkdir -p "${RECORDINGS_DIR}/.quarantine"
    mkdir -p "${POSTGRES_DIR}"
    mkdir -p "${LOG_DIR}"

    # Plant Mount Guard verification probe
    PROBE_FILE="${RECORDINGS_DIR}/.vigilone-mount-probe"
    if [[ ! -f "$PROBE_FILE" ]]; then
        echo "VIGILONE_MOUNT_GUARD_OK_$(date -u +%Y%m%d%H%M%S)" > "$PROBE_FILE"
        chmod 644 "$PROBE_FILE" 2>/dev/null || true
    fi

    # Ensure unprivileged container user (UID 10001) owns recording paths
    chown -R 10001:10001 "${RECORDINGS_DIR}" "${POSTGRES_DIR}" 2>/dev/null || true
}

# ------------------------------------------------------------------------------
# 4a. Application Files Placement
# ------------------------------------------------------------------------------
install_application_files() {
    log_info "Synchronizing VigilOne application files to ${INSTALL_DIR}..."
    mkdir -p "${INSTALL_DIR}"

    if [[ "${SOURCE_DIR}" != "${INSTALL_DIR}" ]]; then
        log_info "Deploying appliance files from ${SOURCE_DIR} to ${INSTALL_DIR}..."

        # Verify source directory contains expected root assets
        if [[ ! -f "${SOURCE_DIR}/docker-compose.yml" || ! -d "${SOURCE_DIR}/backend" ]]; then
            fatal "Source directory ${SOURCE_DIR} does not contain valid VigilOne appliance files."
        fi

        cp -f "${SOURCE_DIR}/docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
        cp -f "${SOURCE_DIR}/Caddyfile" "${INSTALL_DIR}/Caddyfile"
        cp -f "${SOURCE_DIR}/mediamtx.yml" "${INSTALL_DIR}/mediamtx.yml"

        mkdir -p "${INSTALL_DIR}/deploy"
        cp -rf "${SOURCE_DIR}/deploy/." "${INSTALL_DIR}/deploy/"

        mkdir -p "${INSTALL_DIR}/backend"
        cp -rf "${SOURCE_DIR}/backend/." "${INSTALL_DIR}/backend/"

        mkdir -p "${INSTALL_DIR}/frontend"
        cp -rf "${SOURCE_DIR}/frontend/." "${INSTALL_DIR}/frontend/"

        if [[ -d "${SOURCE_DIR}/docs" ]]; then
            mkdir -p "${INSTALL_DIR}/docs"
            cp -rf "${SOURCE_DIR}/docs/." "${INSTALL_DIR}/docs/"
        fi
        log_info "Application files successfully deployed to ${INSTALL_DIR}."
    fi
}

# ------------------------------------------------------------------------------
# 5. Production Cryptographic Secrets Generation (CSPRNG & Idempotency)
# ------------------------------------------------------------------------------
generate_secrets_idempotent() {
    log_info "Configuring cryptographic secrets and appliance vault..."

    ENV_FILE="${INSTALL_DIR}/.env"
    KEY_FILE="${CONFIG_DIR}/appliance.key"
    SETUP_TOKEN_FILE="${CONFIG_DIR}/setup-token.txt"

    # Invariant: If secrets already exist, DO NOT overwrite on installer re-run!
    if [[ -f "$KEY_FILE" && -f "$ENV_FILE" ]]; then
        log_info "Existing appliance secrets detected at ${KEY_FILE} and ${ENV_FILE}. Preserving existing secrets."
        return 0
    fi

    log_info "Generating new 256-bit cryptographically secure secrets via CSPRNG..."

    # 1. Unified Appliance Credential Encryption Key (AES-256-GCM)
    # Stored at /etc/vigilone/appliance.key and injected as CREDENTIAL_ENCRYPTION_KEY
    if [[ ! -f "$KEY_FILE" ]]; then
        openssl rand -base64 32 > "$KEY_FILE"
        chmod 600 "$KEY_FILE" 2>/dev/null || true
        log_info "Appliance Credential Encryption Key generated at ${KEY_FILE}."
    fi
    APPLIANCE_KEY="$(cat "$KEY_FILE" | tr -d '\n\r')"

    # 2. System Service Secrets
    JWT_SECRET="$(openssl rand -hex 32)"
    INTERNAL_API_SECRET="$(openssl rand -hex 32)"
    POSTGRES_PASSWORD="$(openssl rand -hex 24)"
    COTURN_SECRET="$(openssl rand -hex 32)"
    METRICS_AUTH_TOKEN="$(openssl rand -hex 32)"
    SETUP_TOKEN="$(openssl rand -hex 16)"

    # Write ephemeral setup token (24h validity for technician bootstrap)
    echo "$SETUP_TOKEN" > "$SETUP_TOKEN_FILE"
    chmod 600 "$SETUP_TOKEN_FILE" 2>/dev/null || true

    # Detect LAN IP
    if [[ -n "$CUSTOM_LAN_IP" ]]; then
        PRIMARY_IP="$CUSTOM_LAN_IP"
    else
        PRIMARY_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
    fi

    # Write production .env file
    cat << EOF > "$ENV_FILE"
# VigilOne VMS - Production Appliance Environment
# Generated automatically by install.sh on $(date -u)
NODE_ENV=production
PORT=4000
LAN_IP=${PRIMARY_IP}
MANAGEMENT_IP=${PRIMARY_IP}
POSTGRES_USER=vigilone
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=vigilone_db
DATABASE_URL=postgresql://vigilone:${POSTGRES_PASSWORD}@postgres:5432/vigilone_db?schema=public

# Security Secrets (CSPRNG generated)
JWT_SECRET=${JWT_SECRET}
INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
CREDENTIAL_ENCRYPTION_KEY=${APPLIANCE_KEY}
COTURN_SECRET=${COTURN_SECRET}
COTURN_HOST=turn.vigilone.internal
COTURN_PORT=3478
METRICS_AUTH_TOKEN=${METRICS_AUTH_TOKEN}
SETUP_TOKEN=${SETUP_TOKEN}

# Media & Storage Settings
MEDIAMTX_API_URL=http://mediamtx:9997
RECORDINGS_DIR=/recordings
EXPORTS_DIR=/recordings/exports
RECORD_SEGMENT_DURATION=10m
RECORD_PART_DURATION=1s
EOF

    chmod 600 "$ENV_FILE" 2>/dev/null || true
    log_info "Production configuration written to ${ENV_FILE}."
}

# ------------------------------------------------------------------------------
# 6. Docker Engine & Docker Compose Installation
# ------------------------------------------------------------------------------
install_docker_if_missing() {
    if command -v docker &>/dev/null && docker compose version &>/dev/null; then
        log_info "Docker Engine and Docker Compose v2 are already installed."
        return 0
    fi

    log_info "Installing official Docker Engine and Docker Compose v2 plugin..."
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq apt-transport-https ca-certificates curl gnupg lsb-release 2>/dev/null || true

    install -m 0755 -d /etc/apt/keyrings 2>/dev/null || true
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
        chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    fi

    UBUNTU_CODENAME="$(lsb_release -cs 2>/dev/null || echo "jammy")"
    echo "deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null 2>&1 || true

    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true

    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
    log_info "Docker Engine installed and started."
}

# ------------------------------------------------------------------------------
# 6a. Offline / Air-gapped Image Archive Loader
# ------------------------------------------------------------------------------
load_offline_images() {
    local bundle=""
    if [[ -n "$OFFLINE_BUNDLE" ]]; then
        if [[ ! -f "$OFFLINE_BUNDLE" ]]; then
            fatal "Specified offline image bundle does not exist: $OFFLINE_BUNDLE"
        fi
        bundle="$OFFLINE_BUNDLE"
    elif [[ -f "${SOURCE_DIR}/vigilone-images.tar.gz" ]]; then
        bundle="${SOURCE_DIR}/vigilone-images.tar.gz"
    elif [[ -f "${SOURCE_DIR}/vigilone-images.tar" ]]; then
        bundle="${SOURCE_DIR}/vigilone-images.tar"
    elif [[ -f "${INSTALL_DIR}/vigilone-images.tar.gz" ]]; then
        bundle="${INSTALL_DIR}/vigilone-images.tar.gz"
    elif [[ -f "${INSTALL_DIR}/vigilone-images.tar" ]]; then
        bundle="${INSTALL_DIR}/vigilone-images.tar"
    fi

    if [[ -n "$bundle" ]]; then
        log_info "Air-gapped deployment: Loading container images from ${bundle}..."
        if ! docker load -i "$bundle"; then
            fatal "Failed to load container images from offline bundle: $bundle"
        fi
        log_info "Container images successfully loaded into Docker engine."
    fi
}

# ------------------------------------------------------------------------------
# 7. Local Network Discovery (Avahi mDNS -> vigilone.local) & Firewall
# ------------------------------------------------------------------------------
setup_network_services() {
    log_info "Configuring local network discovery and host firewall..."

    # Install Avahi for mDNS broadcasting (vigilone.local)
    if ! command -v avahi-daemon &>/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq 2>/dev/null || true
        apt-get install -y -qq avahi-daemon avahi-utils 2>/dev/null || true
    fi

    if [[ -f "${INSTALL_DIR}/deploy/packaging/vigilone-avahi.service" ]]; then
        cp "${INSTALL_DIR}/deploy/packaging/vigilone-avahi.service" /etc/avahi/services/vigilone.service 2>/dev/null || true
        systemctl restart avahi-daemon 2>/dev/null || true
        log_info "mDNS service active: broadcasting 'vigilone.local' on local LAN."
    fi

    # Host Firewall (UFW) Defense-in-Depth
    if command -v ufw &>/dev/null; then
        log_info "Configuring UFW firewall rules..."
        ufw allow 22/tcp comment "SSH Remote Management" 2>/dev/null || true
        ufw allow 80/tcp comment "VigilOne HTTP Redirect" 2>/dev/null || true
        ufw allow 443/tcp comment "VigilOne Secure HTTPS Gateway" 2>/dev/null || true
        ufw allow 8189/udp comment "VigilOne WebRTC ICE Media" 2>/dev/null || true
        ufw allow 8189/tcp comment "VigilOne WebRTC ICE TCP Fallback" 2>/dev/null || true
        log_info "UFW firewall rules updated (internal ports 5432, 9997, 8554 remain unexposed)."
    fi
}

# ------------------------------------------------------------------------------
# 8. systemd Service Unit Installation
# ------------------------------------------------------------------------------
install_systemd_service() {
    log_info "Installing systemd unit for automated boot startup..."

    if [[ -f "${INSTALL_DIR}/deploy/packaging/vigilone.service" ]]; then
        cp "${INSTALL_DIR}/deploy/packaging/vigilone.service" /etc/systemd/system/vigilone.service 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || true
        systemctl enable vigilone.service 2>/dev/null || true
        log_info "vigilone.service enabled to start on system boot."
    fi
}

# ------------------------------------------------------------------------------
# 9. CLI Link & Start Appliance
# ------------------------------------------------------------------------------
start_appliance_stack() {
    log_info "Installing /usr/local/bin/vigilonectl CLI..."
    if [[ -f "${INSTALL_DIR}/deploy/packaging/vigilonectl" ]]; then
        chmod +x "${INSTALL_DIR}/deploy/packaging/vigilonectl"
        ln -sf "${INSTALL_DIR}/deploy/packaging/vigilonectl" /usr/local/bin/vigilonectl
    else
        fatal "Appliance control binary not found at ${INSTALL_DIR}/deploy/packaging/vigilonectl."
    fi

    if ! command -v docker &>/dev/null; then
        fatal "Docker engine not found. Cannot start appliance stack."
    fi

    log_info "Starting VigilOne CCTV appliance stack via Docker Compose..."
    cd "${INSTALL_DIR}"

    if ! docker compose -f docker-compose.yml -f deploy/packaging/docker-compose.prod.yml up -d --build --remove-orphans; then
        fatal "Docker Compose failed to start the VigilOne appliance stack."
    fi

    # Wait for PostgreSQL container to achieve readiness (max 45 seconds)
    log_info "Waiting for database readiness..."
    local max_retries=45
    local count=0
    local db_ready=false

    while [[ $count -lt $max_retries ]]; do
        if docker compose exec -T postgres pg_isready -U vigilone -d vigilone_db &>/dev/null; then
            db_ready=true
            break
        fi
        sleep 1
        count=$((count + 1))
    done

    if [[ "$db_ready" != "true" ]]; then
        fatal "PostgreSQL container failed to achieve readiness within ${max_retries} seconds."
    fi
    log_info "Database is ready."

    # Run database migration deploy inside container
    log_info "Applying database migrations (prisma migrate deploy)..."
    if ! docker compose exec -T backend npx prisma migrate deploy; then
        fatal "Database migration failed during deployment!"
    fi
    log_info "Database migrations applied successfully."

    # Verify appliance healthcheck
    log_info "Verifying appliance healthcheck..."
    local backend_ready=false
    count=0
    while [[ $count -lt 45 ]]; do
        if curl -f -s http://localhost:80/api/v1/health &>/dev/null || curl -k -f -s https://localhost/api/v1/health &>/dev/null || docker compose exec -T backend curl -f -s http://localhost:4000/api/v1/health &>/dev/null; then
            backend_ready=true
            break
        fi
        sleep 1
        count=$((count + 1))
    done

    if [[ "$backend_ready" != "true" ]]; then
        fatal "Appliance healthcheck verification failed! Service did not achieve readiness within 45s. Check container logs with 'vigilonectl logs backend'."
    fi
    log_info "Appliance stack is online and healthy."
}

# ------------------------------------------------------------------------------
# Main Execution
# ------------------------------------------------------------------------------
main() {
    print_banner
    preflight_checks
    init_directories_and_mountguard
    install_application_files
    provision_storage_disk
    generate_secrets_idempotent
    install_docker_if_missing
    load_offline_images
    setup_network_services
    install_systemd_service
    start_appliance_stack


    SETUP_TOKEN="$(cat "${CONFIG_DIR}/setup-token.txt" 2>/dev/null || echo "N/A")"
    PRIMARY_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"

    echo ""
    echo -e "${GREEN}================================================================================"
    echo "       VigilOne VMS Appliance Installation Successfully Completed!             "
    echo "================================================================================${NC}"
    echo ""
    echo "  1. Open your browser and navigate to:"
    echo -e "     ${BLUE}https://vigilone.local${NC}  or  ${BLUE}https://${PRIMARY_IP}${NC}"
    echo ""
    echo "  2. Complete the First-Run Setup Wizard using your Setup PIN:"
    echo -e "     SETUP PIN: ${YELLOW}${SETUP_TOKEN}${NC}"
    echo ""
    echo "  3. Appliance Management CLI is ready:"
    echo "     $ vigilonectl status"
    echo "     $ vigilonectl token"
    echo "     $ vigilonectl logs"
    echo "     $ vigilonectl support-bundle"
    echo ""
    echo -e "${GREEN}================================================================================${NC}"
}

main
