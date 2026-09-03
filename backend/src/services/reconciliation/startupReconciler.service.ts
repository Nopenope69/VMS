import axios from 'axios';
import { PrismaClient, RecorderState } from '@prisma/client';
import config from '../../config/env';
import mediaProvider from '../media/mediamtx.provider';

export interface ReconciliationReport {
  totalCameras: number;
  reconciledCount: number;
  healedPaths: number;
  errors: string[];
}

export class StartupReconcilerService {
  private static prisma = new PrismaClient();

  /**
   * Reconciles desired recorder state in PostgreSQL with actual MediaMTX engine status.
   * Auto-heals missing paths and starts recording for cameras configured as continuous.
   */
  public static async reconcile(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      totalCameras: 0,
      reconciledCount: 0,
      healedPaths: 0,
      errors: [],
    };

    try {
      const cameras = await this.prisma.camera.findMany();
      report.totalCameras = cameras.length;

      // 1. Query active paths from MediaMTX
      let mediaMtxPaths = new Set<string>();
      try {
        const res = await axios.get(`${config.MEDIAMTX_API_URL}/v3/paths/list`, {
          timeout: 3000,
        });
        const items = res.data?.items || [];
        for (const item of items) {
          if (item.name) mediaMtxPaths.add(item.name);
        }
      } catch (err: any) {
        report.errors.push(`MediaMTX Control API unreachable at ${config.MEDIAMTX_API_URL}: ${err.message}`);
      }

      // 2. Iterate through cameras and reconcile desired vs observed state
      for (const camera of cameras) {
        const pathExists = mediaMtxPaths.has(camera.streamPath);
        const shouldRecord = camera.recordingMode === 'CONTINUOUS' || camera.desiredRecorderState === 'RUNNING';

        let observedState: RecorderState = RecorderState.STOPPED;

        if (shouldRecord) {
          if (!pathExists) {
            // Self-heal: Re-inject path and command MediaMTX to start recording
            console.warn(`[StartupReconciler] Healing missing MediaMTX path for camera ${camera.name} (${camera.streamPath})`);
            try {
              await mediaProvider.setRecording(camera.id, true);
              observedState = RecorderState.RUNNING;
              report.healedPaths++;
            } catch (err: any) {
              observedState = RecorderState.ERROR;
              report.errors.push(`Failed to heal camera ${camera.id}: ${err.message}`);
            }
          } else {
            observedState = RecorderState.RUNNING;
          }
        } else {
          observedState = RecorderState.STOPPED;
        }

        // Update camera states in DB
        await this.prisma.camera.update({
          where: { id: camera.id },
          data: {
            observedRecorderState: observedState,
            recorderState: observedState,
            desiredRecorderState: shouldRecord ? RecorderState.RUNNING : RecorderState.STOPPED,
            lastReconciledAt: new Date(),
          },
        });

        report.reconciledCount++;
      }

      // 3. Reset any orphaned PROCESSING jobs back to PENDING so the worker pool resumes them
      await this.prisma.segmentJob.updateMany({
        where: { status: 'PROCESSING' },
        data: { status: 'PENDING' },
      });

      console.info(
        `[StartupReconciler] Reconciliation complete: ${report.reconciledCount}/${report.totalCameras} cameras synchronized, ${report.healedPaths} paths healed.`
      );
    } catch (err: any) {
      console.error('[StartupReconciler] Critical failure during startup reconciliation:', err.message);
      report.errors.push(err.message);
    }

    return report;
  }
}

export default StartupReconcilerService;
