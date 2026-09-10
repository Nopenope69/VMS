import os from "os";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { PrismaClient } from "@prisma/client";
import { StorageVolumeService } from "../storage/storageVolume.service";

export interface ApplianceIdentity {
  applianceId: string;
  softwareVersion: string;
  nodeFingerprint: string;
  isBootstrapped: boolean;
  bootstrappedAt: Date | null;
  installedAt: Date;
}

export interface SystemVitals {
  uptimeSeconds: number;
  cpuLoad: number[];
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    percentUsed: number;
  };
  os: {
    platform: string;
    release: string;
    arch: string;
    hostname: string;
  };
  storage: {
    totalBytes: string;
    availableBytes: string;
    percentUsed: number;
    mountGuardStatus: "HEALTHY" | "DEGRADED";
  };
  cameras: {
    total: number;
    degraded: number;
  };
  timestamp: string;
}

export class ApplianceService {
  private prisma: PrismaClient;
  private storageVolumeService: StorageVolumeService;

  constructor(prisma: PrismaClient, storageVolumeService?: StorageVolumeService) {
    this.prisma = prisma;
    this.storageVolumeService = storageVolumeService || new StorageVolumeService(prisma);
  }

  /**
   * Returns authoritative appliance identity (post-authentication)
   */
  async getApplianceIdentity(): Promise<ApplianceIdentity> {
    let isBootstrapped = false;
    let bootstrappedAt: Date | null = null;
    let applianceId = "vigilone-edge-appliance-01";
    let installedAt = new Date("2026-01-01T00:00:00Z");

    if (typeof (this.prisma as any).applianceState?.findUnique === "function") {
      try {
        const state = await (this.prisma as any).applianceState.findUnique({
          where: { id: "SINGLETON" },
        });
        if (state) {
          isBootstrapped = state.isBootstrapped;
          bootstrappedAt = state.bootstrappedAt;
          applianceId = state.applianceId || applianceId;
          installedAt = state.createdAt || installedAt;
        }
      } catch {}
    }

    if (!isBootstrapped && typeof this.prisma.user?.count === "function") {
      try {
        const count = await this.prisma.user.count({ where: { role: "SUPER_ADMIN" } });
        isBootstrapped = count > 0;
      } catch {}
    }

    // Node signing fingerprint (SHA-256 derived from appliance ID or public key)
    const nodeFingerprint = crypto
      .createHash("sha256")
      .update(applianceId + "_vigilone_node_key")
      .digest("hex")
      .substring(0, 16);

    return {
      applianceId,
      softwareVersion: "1.0.0",
      nodeFingerprint,
      isBootstrapped,
      bootstrappedAt,
      installedAt,
    };
  }

  /**
   * Gathers hardware, container, storage, and camera vitals
   */
  async getSystemVitals(): Promise<SystemVitals> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Storage metrics via Mount Guard
    let totalStorage = 0n;
    let availableStorage = 0n;
    let mountGuardStatus: "HEALTHY" | "DEGRADED" = "HEALTHY";

    try {
      const volumeHealth = await this.storageVolumeService.checkAllVolumes();
      for (const v of volumeHealth) {
        totalStorage += v.sizeBytes;
        availableStorage += v.freeBytes;
        if (v.status !== "HEALTHY") {
          mountGuardStatus = "DEGRADED";
        }
      }
    } catch {
      // Fallback
    }

    const storagePercent = totalStorage > 0n
      ? Number(((totalStorage - availableStorage) * 100n) / totalStorage)
      : 0;

    // Camera stats
    let totalCameras = 0;
    let degradedCameras = 0;
    if (typeof this.prisma.camera?.findMany === "function") {
      try {
        const cameras = await this.prisma.camera.findMany({
          select: { id: true, effectiveRecordingMode: true, recordingMode: true },
        });
        totalCameras = cameras.length;
        degradedCameras = cameras.filter(
          (c: any) => c.effectiveRecordingMode && c.effectiveRecordingMode !== c.recordingMode
        ).length;
      } catch {}
    }

    return {
      uptimeSeconds: Math.floor(os.uptime()),
      cpuLoad: os.loadavg(),
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        percentUsed: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      },
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
      },
      storage: {
        totalBytes: totalStorage.toString(),
        availableBytes: availableStorage.toString(),
        percentUsed: storagePercent,
        mountGuardStatus,
      },
      cameras: {
        total: totalCameras,
        degraded: degradedCameras,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sanitizes all sensitive data (passwords, JWTs, keys, credentials)
   * Contract Requirement: Must strip JWTs, Bearer tokens, DB credentials, RTSP passwords, and keys.
   */
  public sanitizeContent(raw: string): string {
    if (!raw) return "";

    return raw
      // Strip JWTs (header.payload.signature)
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[SANITIZED_JWT]")
      // Strip Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9_.-]{8,}/g, "Bearer [SANITIZED_TOKEN]")
      // Strip Authorization headers
      .replace(/Authorization:\s*[^\r\n]+/gi, "Authorization: [SANITIZED]")
      // Strip PostgreSQL connection URLs with passwords
      .replace(/postgresql:\/\/([^:]+):([^@]+)@/g, "postgresql://$1:[SANITIZED]@")
      // Strip RTSP URLs with passwords
      .replace(/rtsp:\/\/([^:]+):([^@]+)@/g, "rtsp://$1:[SANITIZED]@")
      // Strip PEM private keys
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[SANITIZED_PRIVATE_KEY]")
      // Strip environment assignments with passwords and secrets
      .replace(
        /(JWT_SECRET|INTERNAL_API_SECRET|POSTGRES_PASSWORD|COTURN_SECRET|CREDENTIAL_ENCRYPTION_KEY|SETUP_TOKEN)\s*=\s*[^\r\n]+/g,
        "$1=[SANITIZED]"
      );
  }

  /**
   * Generates a sanitized .tar.gz support bundle in a bounded temporary archive
   */
  async generateSupportBundle(outputTarGzPath: string): Promise<string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vigilone-bundle-"));

    try {
      const identity = await this.getApplianceIdentity();
      const vitals = await this.getSystemVitals();

      // 1. Write identity and vitals
      fs.writeFileSync(
        path.join(tmpDir, "appliance_identity.json"),
        JSON.stringify(identity, null, 2)
      );
      fs.writeFileSync(
        path.join(tmpDir, "system_vitals.json"),
        JSON.stringify(vitals, null, 2)
      );

      // 2. Sanitized Environment Configuration dump
      const sanitizedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (
          k.includes("SECRET") ||
          k.includes("PASSWORD") ||
          k.includes("KEY") ||
          k.includes("TOKEN") ||
          k.includes("DATABASE_URL")
        ) {
          sanitizedEnv[k] = "[SANITIZED]";
        } else {
          sanitizedEnv[k] = v || "";
        }
      }
      fs.writeFileSync(
        path.join(tmpDir, "environment_sanitized.json"),
        JSON.stringify(sanitizedEnv, null, 2)
      );

      // 3. Storage mount inspection
      let mounts = "N/A";
      try {
        if (fs.existsSync("/proc/mounts")) {
          mounts = this.sanitizeContent(fs.readFileSync("/proc/mounts", "utf8"));
        }
      } catch {}
      fs.writeFileSync(path.join(tmpDir, "proc_mounts.txt"), mounts);

      // 4. Archive into output .tar.gz
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputTarGzPath);
        const archive = archiver("tar", {
          gzip: true,
          gzipOptions: { level: 6 },
        });

        output.on("close", () => resolve());
        archive.on("error", (err) => reject(err));

        archive.pipe(output);
        archive.directory(tmpDir, false);
        archive.finalize();
      });

      return outputTarGzPath;
    } finally {
      // Cleanup temporary directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
