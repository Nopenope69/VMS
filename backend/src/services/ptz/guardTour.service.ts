import { PrismaClient, TourState } from '@prisma/client';
import onvifManager, { OnvifCredentials } from '../onvif/client';
import ptzArbiterService from './ptzArbiter.service';

export interface TourStep {
  presetToken: string;
  presetName?: string;
  dwellSeconds: number;
  speed?: number;
}

export class GuardTourService {
  private prisma: PrismaClient;
  private runningLoops = new Map<string, { abort: boolean }>();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async startTour(
    tourId: string,
    creds: OnvifCredentials,
    profileToken = 'Profile_1'
  ): Promise<void> {
    const tour = await this.prisma.ptzTour.findUnique({
      where: { id: tourId },
      include: { camera: true },
    });

    if (!tour) {
      throw new Error(`Tour ${tourId} not found`);
    }

    const cameraId = tour.cameraId;

    // Stop existing loop if running
    this.stopTourSync(cameraId);

    const steps = (tour.stepsJson as unknown as TourStep[]) || [];
    if (steps.length === 0) {
      throw new Error(`Tour ${tour.name} has no configured steps`);
    }

    const loopControl = { abort: false };
    this.runningLoops.set(cameraId, loopControl);

    // Register with Arbiter
    ptzArbiterService.registerTourStarted(cameraId, tourId, async () => {
      // Resume callback
      console.log(`[GuardTour] Resuming patrol on camera ${cameraId} after operator inactivity`);
    });

    await this.prisma.ptzTour.update({
      where: { id: tourId },
      data: { state: TourState.RUNNING },
    });

    // Run patrol loop in background
    this.runPatrolLoop(tourId, cameraId, steps, creds, profileToken, loopControl).catch((err) => {
      console.error(`[GuardTour] Loop error for tour ${tourId}:`, err.message);
    });
  }

  private async runPatrolLoop(
    tourId: string,
    cameraId: string,
    steps: TourStep[],
    creds: OnvifCredentials,
    profileToken: string,
    loopControl: { abort: boolean }
  ): Promise<void> {
    let stepIndex = 0;

    while (!loopControl.abort) {
      const arbiter = ptzArbiterService.getState(cameraId);

      if (arbiter.state === TourState.STOPPED) {
        break;
      }

      if (arbiter.state === TourState.MANUAL_OVERRIDE || arbiter.state === TourState.PAUSED) {
        // Operator is currently moving PTZ or tour is paused. Wait and retry
        await this.sleep(1000);
        continue;
      }

      const step = steps[stepIndex];

      try {
        await onvifManager.gotoPreset(creds, profileToken, step.presetToken, step.speed);
      } catch (err: any) {
        console.warn(`[GuardTour] Preset goto failed on step ${stepIndex}:`, err.message);
      }

      // Dwell at preset location (evaluating abort each second)
      const dwellMs = Math.max(step.dwellSeconds, 1) * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < dwellMs && !loopControl.abort) {
        const state = ptzArbiterService.getState(cameraId);
        if (state.state === TourState.MANUAL_OVERRIDE || state.state === TourState.STOPPED) {
          break;
        }
        await this.sleep(500);
      }

      stepIndex = (stepIndex + 1) % steps.length;
    }

    // Cleanup when loop terminates
    this.runningLoops.delete(cameraId);
    ptzArbiterService.registerTourStopped(cameraId);

    await this.prisma.ptzTour.updateMany({
      where: { id: tourId },
      data: { state: TourState.STOPPED },
    });
  }

  stopTourSync(cameraId: string): void {
    const loop = this.runningLoops.get(cameraId);
    if (loop) {
      loop.abort = true;
      this.runningLoops.delete(cameraId);
    }
    ptzArbiterService.registerTourStopped(cameraId);
  }

  async stopTour(tourId: string): Promise<void> {
    const tour = await this.prisma.ptzTour.findUnique({ where: { id: tourId } });
    if (tour) {
      this.stopTourSync(tour.cameraId);
      await this.prisma.ptzTour.update({
        where: { id: tourId },
        data: { state: TourState.STOPPED },
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const guardTourService = new GuardTourService(new PrismaClient());
export default guardTourService;
