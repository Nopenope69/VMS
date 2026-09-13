/**
 * VigilOne 64-Camera Soak Test Topology Specification
 * Strict conformance to Master Execution Contract Section 3.1.1
 * 4 Vendor Cohorts (16 streams each = 64 concurrent streams)
 */

export interface CameraWorkloadProfile {
  id: string;
  name: string;
  cohort: 'HIKVISION' | 'DAHUA' | 'CP_PLUS' | 'ONVIF_PROFILE_ST';
  manufacturer: string;
  model: string;
  firmwareVersion: string;
  streamPath: string;
  resolutionPrimary: string;
  fpsPrimary: number;
  bitrateKbpsPrimary: number;
  resolutionSub: string;
  fpsSub: number;
  bitrateKbpsSub: number;
  codec: 'h264' | 'h265';
  gopFrames: number;
  keyframeIntervalSec: number;
  transport: 'TCP';
  recordingFormat: 'fmp4';
  segmentDurationSec: number;
  partDurationSec: number;
}

export interface ApplianceHardwareSku {
  cpuModel: string;
  physicalCores: number;
  logicalCores: number;
  ramGigabytes: number;
  driveInterface: 'NVMe' | 'SATA_SSD' | 'SATA_HDD_ENTERPRISE';
  filesystem: 'ext4';
  mountOptions: string;
}

export const APPLIANCE_BASELINE_SKU: ApplianceHardwareSku = {
  cpuModel: 'Intel Xeon E-2388G @ 3.20GHz (or AMD EPYC 7302P)',
  physicalCores: 8,
  logicalCores: 16,
  ramGigabytes: 64,
  driveInterface: 'NVMe',
  filesystem: 'ext4',
  mountOptions: 'noatime,data=writeback,barrier=0,commit=60',
};

export function generate64CameraTopology(): CameraWorkloadProfile[] {
  const cameras: CameraWorkloadProfile[] = [];

  // Cohort 1: 16x Hikvision
  for (let i = 1; i <= 16; i++) {
    cameras.push({
      id: `cam-hik-${String(i).padStart(2, '0')}`,
      name: `Hikvision Dome ${i}`,
      cohort: 'HIKVISION',
      manufacturer: 'Hikvision',
      model: 'DS-2CD2143G2-I',
      firmwareVersion: 'V5.7.13_build230915',
      streamPath: `hikvision-dome-${i}`,
      resolutionPrimary: '1920x1080',
      fpsPrimary: 25,
      bitrateKbpsPrimary: 2500,
      resolutionSub: '640x360',
      fpsSub: 10,
      bitrateKbpsSub: 512,
      codec: 'h264',
      gopFrames: 50,
      keyframeIntervalSec: 2.0,
      transport: 'TCP',
      recordingFormat: 'fmp4',
      segmentDurationSec: 600, // 10 minutes
      partDurationSec: 1,      // 1-second fMP4 parts
    });
  }

  // Cohort 2: 16x Dahua
  for (let i = 1; i <= 16; i++) {
    cameras.push({
      id: `cam-dahua-${String(i).padStart(2, '0')}`,
      name: `Dahua Bullet ${i}`,
      cohort: 'DAHUA',
      manufacturer: 'Dahua Technology',
      model: 'IPC-HFW2431S-S-S2',
      firmwareVersion: 'V2.820.0000000.12.R.230804',
      streamPath: `dahua-bullet-${i}`,
      resolutionPrimary: '1920x1080',
      fpsPrimary: 25,
      bitrateKbpsPrimary: 2500,
      resolutionSub: '640x360',
      fpsSub: 10,
      bitrateKbpsSub: 512,
      codec: 'h264',
      gopFrames: 50,
      keyframeIntervalSec: 2.0,
      transport: 'TCP',
      recordingFormat: 'fmp4',
      segmentDurationSec: 600,
      partDurationSec: 1,
    });
  }

  // Cohort 3: 16x CP Plus
  for (let i = 1; i <= 16; i++) {
    cameras.push({
      id: `cam-cpplus-${String(i).padStart(2, '0')}`,
      name: `CP Plus Turret ${i}`,
      cohort: 'CP_PLUS',
      manufacturer: 'CP Plus',
      model: 'CP-UNC-TA41PL3-V2',
      firmwareVersion: 'V2.800.0000000.5.R.231012',
      streamPath: `cpplus-turret-${i}`,
      resolutionPrimary: '1920x1080',
      fpsPrimary: 25,
      bitrateKbpsPrimary: 2500,
      resolutionSub: '640x360',
      fpsSub: 10,
      bitrateKbpsSub: 512,
      codec: 'h264',
      gopFrames: 50,
      keyframeIntervalSec: 2.0,
      transport: 'TCP',
      recordingFormat: 'fmp4',
      segmentDurationSec: 600,
      partDurationSec: 1,
    });
  }

  // Cohort 4: 16x ONVIF Profile S/T compliant
  for (let i = 1; i <= 16; i++) {
    cameras.push({
      id: `cam-onvif-${String(i).padStart(2, '0')}`,
      name: `ONVIF Multi-Vendor ${i}`,
      cohort: 'ONVIF_PROFILE_ST',
      manufacturer: 'Uniview',
      model: 'IPC2124SR3-DPF40',
      firmwareVersion: 'UNV-B3321.23.12.B231120',
      streamPath: `onvif-camera-${i}`,
      resolutionPrimary: '1920x1080',
      fpsPrimary: 25,
      bitrateKbpsPrimary: 2500,
      resolutionSub: '640x360',
      fpsSub: 10,
      bitrateKbpsSub: 512,
      codec: 'h264',
      gopFrames: 50,
      keyframeIntervalSec: 2.0,
      transport: 'TCP',
      recordingFormat: 'fmp4',
      segmentDurationSec: 600,
      partDurationSec: 1,
    });
  }

  return cameras;
}
