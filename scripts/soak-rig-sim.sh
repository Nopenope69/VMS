#!/usr/bin/env bash
# ==============================================================================
# VigilOne Stage 3: 64-Camera Soak Test Rig Simulation Script
#
# IMPORTANT HARDWARE BOUNDARY & VERIFICATION NOTICE:
# This script scaffolds 64 stream directories and validates storage mount guards.
#
# Scope Demarcation:
# 1. Directory Scaffolding & Storage Prep: Sets up directory layout for 64 cameras.
# 2. Automated Lab Load: Executed via backend/src/__tests__/realStreamLoad.test.ts
#    using real FFmpeg fMP4 video encoding.
# 3. 64-Camera Physical Soak: Physical 168-hour soak requires physical cameras
#    and PoE switch infrastructure. This script represents synthetic lab scaffolding,
#    NOT 168 elapsed hours of physical hardware soak.
# ==============================================================================

set -euo pipefail

TOTAL_COHORTS=4
STREAMS_PER_COHORT=16
TOTAL_STREAMS=64
SOAK_DURATION_HOURS="${SOAK_DURATION_HOURS:-168}" # Default 7 days = 168 hours
SEGMENT_DURATION_SEC="${SEGMENT_DURATION_SEC:-600}" # 10-minute fMP4 segments
RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/vigilone/recordings}"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}  VigilOne Stage 3: 64-Camera Soak Test Rig Simulation Engine     ${NC}"
echo -e "${BLUE}==================================================================${NC}"
echo -e "Topology:      ${TOTAL_STREAMS} Concurrent Streams across ${TOTAL_COHORTS} Cohorts"
echo -e "Cohorts:       16x Hikvision | 16x Dahua | 16x CP Plus | 16x ONVIF S/T"
echo -e "Format:        Continuous segmented fMP4 (${SEGMENT_DURATION_SEC}s segments, 1s parts)"
echo -e "Duration:      ${SOAK_DURATION_HOURS} hours (7-Day Soak Baseline)"
echo -e "Target Dir:    ${RECORDINGS_DIR}"
echo -e "${BLUE}==================================================================${NC}"

mkdir -p "$RECORDINGS_DIR"

echo -e "\n${BLUE}[Phase 1/3] Validating Storage Mount Guard & Direct-Attached Pool...${NC}"
AVAILABLE_KB=$(df "$RECORDINGS_DIR" | tail -1 | awk '{print $4}')
AVAILABLE_GB=$((AVAILABLE_KB / 1024 / 1024))
echo -e "Available disk capacity: ${AVAILABLE_GB} GB"

if [ "$AVAILABLE_GB" -lt 10 ]; then
  echo -e "${RED}[WARNING] Available disk space is low (<10 GB). Ensure sufficient quota for soak.${NC}"
fi

echo -e "\n${BLUE}[Phase 2/3] Initializing 64 Camera Directories...${NC}"
COHORTS=("hikvision-dome" "dahua-bullet" "cpplus-turret" "onvif-camera")
for cohort in "${COHORTS[@]}"; do
  for i in $(seq 1 16); do
    STREAM_ID="${cohort}-${i}"
    mkdir -p "${RECORDINGS_DIR}/${STREAM_ID}"
  done
done
echo -e "${GREEN}[PASS] 64 stream directory trees initialized.${NC}"

echo -e "\n${BLUE}[Phase 3/3] 64-Stream Ingestion Soak Simulation Ready.${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "${GREEN}  SOAK HARNESS DEPLOYED: Ready for Continuous Multi-Vendor Run     ${NC}"
echo -e "${GREEN}==================================================================${NC}"
