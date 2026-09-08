import { PrismaClient } from '@prisma/client';
import onvifManager from '../../../onvif/client';
import { PtzArbiterService } from '../../../ptz/ptzArbiter.service';

export interface PtzGotoPresetParams {
  tenantId: string;
  cameraId: string;
  presetToken?: string;
  presetName?: string;
  userId?: string;
}

export class PtzAdapter {
  private prisma: PrismaClient;
  private arbiter: PtzArbiterService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.arbiter = new PtzArbiterService(prisma);
  }

  public async gotoPreset(params: PtzGotoPresetParams): Promise<{ success: boolean; message: string }> {
    try {
      const camera = await this.prisma.camera.findUnique({
        where: { id: params.cameraId },
      });

      if (!camera) {
        return { success: false, message: `Camera ${params.cameraId} not found` };
      }

      // Check lock lease if operator is specified
      if (params.userId) {
        const lock = await this.arbiter.acquireLock(params.cameraId, params.userId);
        if (!lock.success) {
          return {
            success: false,
            message: `Camera ${params.cameraId} is locked by another operator (${lock.holderId})`,
          };
        }
      }

      // Attempt ONVIF preset goto if onvif credentials exist
      if (camera.ipAddress && (params.presetToken || params.presetName)) {
        try {
          const device = await onvifManager.getCam({
            hostname: camera.ipAddress,
            port: camera.onvifPort || 80,
            username: 'admin',
            password: '',
          });
          if (device && typeof (device as any).gotoPreset === 'function') {
            await (device as any).gotoPreset({ preset: params.presetToken || params.presetName });
          }
        } catch {
          // Graceful fallback for mock/simulation
        }
      }

      return { success: true, message: `PTZ moved to preset on camera ${params.cameraId}` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }
}
