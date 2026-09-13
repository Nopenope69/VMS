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

      // Validate camera network configuration and target preset
      if (!camera.ipAddress) {
        return { success: false, message: `Camera ${params.cameraId} has no IP address configured for PTZ` };
      }

      const targetPreset = params.presetToken || params.presetName;
      if (!targetPreset) {
        return { success: false, message: `Neither presetToken nor presetName provided for camera ${params.cameraId}` };
      }

      // Attempt ONVIF preset goto
      try {
        const device = await onvifManager.getCam({
          hostname: camera.ipAddress,
          port: camera.onvifPort || 80,
          username: 'admin',
          password: '',
        });
        if (!device || typeof (device as any).gotoPreset !== 'function') {
          return {
            success: false,
            message: `ONVIF device for camera ${params.cameraId} does not support gotoPreset`,
          };
        }
        await (device as any).gotoPreset({ preset: targetPreset });
        return { success: true, message: `PTZ moved to preset on camera ${params.cameraId}` };
      } catch (err: any) {
        return {
          success: false,
          message: `ONVIF PTZ command failed for camera ${params.cameraId}: ${err.message}`,
        };
      }
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }
}
