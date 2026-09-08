import { TourState } from '@prisma/client';
import { PtzArbiterService } from '../services/ptz/ptzArbiter.service';
import onvifManager from '../services/onvif/client';

jest.mock('../services/onvif/client', () => ({
  ptzContinuousMove: jest.fn().mockResolvedValue(undefined),
  ptzStop: jest.fn().mockResolvedValue(undefined),
  gotoPreset: jest.fn().mockResolvedValue(undefined),
}));

describe('PtzArbiterService - Concurrency Lock & Preemption Arbiter', () => {
  let service: PtzArbiterService;
  let mockPrisma: any;
  let activeLock: any = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    activeLock = null;

    mockPrisma = {
      ptzLock: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(activeLock)),
        upsert: jest.fn().mockImplementation(({ update, create }) => {
          activeLock = { ...create, ...update };
          return Promise.resolve(activeLock);
        }),
        delete: jest.fn().mockImplementation(() => {
          activeLock = null;
          return Promise.resolve({});
        }),
      },
    };

    service = new PtzArbiterService(mockPrisma);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Operator Lock Lease & Collision Prevention', () => {
    it('should grant lock lease to first operator', async () => {
      const res = await service.acquireLock('cam_ptz_01', 'user_alpha', 10000);
      expect(res.success).toBe(true);
      expect(activeLock).toBeDefined();
      expect(activeLock.userId).toBe('user_alpha');
    });

    it('should REJECT second operator when active lock held by first operator (409 Conflict)', async () => {
      // User Alpha acquires lock
      await service.acquireLock('cam_ptz_01', 'user_alpha', 15000);

      // User Bravo attempts manual move
      const creds = { hostname: '192.168.1.100', port: 80 };
      await expect(
        service.manualMove('cam_ptz_01', 'user_bravo', creds, 'Profile_1', { x: 1, y: 0 })
      ).rejects.toThrow(/locked by another operator \(user_alpha\)/);

      // ONVIF camera must NOT have been moved by the unauthorized collision
      expect(onvifManager.ptzContinuousMove).not.toHaveBeenCalled();
    });

    it('should allow lock acquisition after lease expires', async () => {
      // Expired lock held by Alpha
      activeLock = {
        cameraId: 'cam_ptz_01',
        userId: 'user_alpha',
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      };

      const res = await service.acquireLock('cam_ptz_01', 'user_bravo', 15000);
      expect(res.success).toBe(true);
      expect(activeLock.userId).toBe('user_bravo');
    });
  });

  describe('Guard Tour Preemption & Inactivity Auto-Resumption', () => {
    it('should preempt running guard tour when operator issues manual move', async () => {
      const resumeCallback = jest.fn().mockResolvedValue(undefined);
      service.registerTourStarted('cam_ptz_01', 'tour_perimeter_01', resumeCallback);

      let state = service.getState('cam_ptz_01');
      expect(state.state).toBe(TourState.RUNNING);

      // Operator Alpha commands a manual move
      const creds = { hostname: '192.168.1.100', port: 80 };
      await service.manualMove('cam_ptz_01', 'user_alpha', creds, 'Profile_1', { x: -1, y: 0 });

      // State MUST transition to MANUAL_OVERRIDE immediately!
      state = service.getState('cam_ptz_01');
      expect(state.state).toBe(TourState.MANUAL_OVERRIDE);
      expect(onvifManager.ptzContinuousMove).toHaveBeenCalledWith(creds, 'Profile_1', { x: -1, y: 0 });
    });

    it('should automatically resume preempted guard tour after operator inactivity timeout', async () => {
      const resumeCallback = jest.fn().mockResolvedValue(undefined);
      service.registerTourStarted('cam_ptz_01', 'tour_perimeter_01', resumeCallback);

      const creds = { hostname: '192.168.1.100', port: 80 };
      await service.manualMove('cam_ptz_01', 'user_alpha', creds, 'Profile_1', { x: 0, y: 1 });

      expect(service.getState('cam_ptz_01').state).toBe(TourState.MANUAL_OVERRIDE);

      // Trigger the 30-second inactivity timeout
      await service.handleInactivityTimeout('cam_ptz_01');

      // State MUST automatically transition back to RUNNING and invoke resume callback!
      expect(service.getState('cam_ptz_01').state).toBe(TourState.RUNNING);
      expect(resumeCallback).toHaveBeenCalledTimes(1);
    });
  });
});
