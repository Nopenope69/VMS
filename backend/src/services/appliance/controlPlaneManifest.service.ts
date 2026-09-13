import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const DEFAULT_MANIFEST_PATH = process.env.APPLIANCE_MANIFEST_PATH || '/etc/vigilone/appliance_manifest.json';

export interface CameraTopologyRecord {
  id: string;
  name: string;
  streamPath: string;
  storageVolumeId?: string | null;
  tenantId: string;
}

export interface ApplianceManifest {
  version: 1;
  updatedAt: string;
  applianceId: string;
  tenantId: string;
  cameras: CameraTopologyRecord[];
}

export class ControlPlaneManifestService {
  private static manifestPath: string = DEFAULT_MANIFEST_PATH;

  public static setManifestPath(p: string): void {
    this.manifestPath = p;
  }

  public static getManifestPath(): string {
    return this.manifestPath;
  }

  public static reset(): void {
    this.manifestPath = process.env.APPLIANCE_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
  }

  /**
   * Reads the trusted host appliance configuration manifest.
   */
  public static loadManifest(): ApplianceManifest | null {
    try {
      if (fs.existsSync(this.manifestPath)) {
        return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      }
    } catch (err: any) {
      console.warn(`[ControlPlaneManifestService] Warning reading manifest from ${this.manifestPath}: ${err.message}`);
    }
    return null;
  }

  /**
   * Mirrors the current database camera and appliance topology to protected host state.
   */
  public static async syncFromDatabase(prisma: PrismaClient, applianceId: string = 'appliance-default'): Promise<void> {
    try {
      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      const tenantId = tenant?.id || 'default-tenant';

      const cameras = await prisma.camera.findMany({
        select: {
          id: true,
          name: true,
          streamPath: true,
          storageVolumeId: true,
          tenantId: true,
        },
      });

      const manifest: ApplianceManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        applianceId,
        tenantId,
        cameras,
      };

      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.manifestPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.manifestPath);
    } catch (err: any) {
      console.warn(`[ControlPlaneManifestService] Warning syncing manifest to ${this.manifestPath}: ${err.message}`);
    }
  }

  /**
   * Deterministically resolves camera and tenant ownership for a filesystem stream path
   * using the surviving trusted host manifest.
   */
  public static resolveCameraForStreamPath(streamPath: string): CameraTopologyRecord | null {
    const manifest = this.loadManifest();
    if (!manifest || !manifest.cameras) {
      return null;
    }
    const found = manifest.cameras.find((c) => c.streamPath === streamPath || c.id === streamPath);
    return found || null;
  }
}

export default ControlPlaneManifestService;
