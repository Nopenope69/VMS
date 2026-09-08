import { SceneChangeDetectorService } from '../services/motion/sceneChangeDetector.service';
import mediaProvider from '../services/media/mediamtx.provider';

jest.mock('../services/media/mediamtx.provider', () => ({
  setRecording: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@prisma/client', () => {
  const mEvent = {
    create: jest.fn().mockResolvedValue({ id: 'event_mock_001' }),
    update: jest.fn().mockResolvedValue({ id: 'event_mock_001' }),
  };
  return {
    PrismaClient: jest.fn(() => ({
      event: mEvent,
      detectionZone: { findMany: jest.fn().mockResolvedValue([]) },
    })),
    EventType: { MOTION: 'MOTION' },
    EventSeverity: { INFO: 'INFO' },
  };
});

describe('Scene-Change Episode State Machine', () => {
  let detector: SceneChangeDetectorService;

  beforeEach(() => {
    jest.clearAllMocks();
    detector = new SceneChangeDetectorService(500); // 500ms test cooldown
  });

  afterEach(() => {
    detector.destroy();
  });

  it('should transition from IDLE to ACTIVE on initial scene change and start recording', async () => {
    const cameraId = 'cam_test_01';
    await detector.handleSceneChange(cameraId, 0.65);

    const state = detector.getState(cameraId);
    expect(state).toBeDefined();
    expect(state?.state).toBe('ACTIVE');
    expect(state?.motionSpikes).toBe(1);
    expect(mediaProvider.setRecording).toHaveBeenCalledWith(cameraId, true);
  });

  it('should consolidate consecutive spikes into the same episode without spawning new events', async () => {
    const cameraId = 'cam_test_02';

    // Spike 1
    await detector.handleSceneChange(cameraId, 0.5);
    // Spike 2 (immediate)
    await detector.handleSceneChange(cameraId, 0.7);
    // Spike 3 (immediate)
    await detector.handleSceneChange(cameraId, 0.8);

    const state = detector.getState(cameraId);
    expect(state?.motionSpikes).toBe(3);
    // setRecording was only called ONCE to start recording for this whole episode
    expect(mediaProvider.setRecording).toHaveBeenCalledTimes(1);
    expect(mediaProvider.setRecording).toHaveBeenCalledWith(cameraId, true);
  });

  it('should stop recording and finalize episode when cooldown expires', async () => {
    const cameraId = 'cam_test_03';
    await detector.handleSceneChange(cameraId, 0.55);

    // Explicitly finalize episode (simulating timer expiry)
    await detector.finalizeEpisode(cameraId);

    expect(mediaProvider.setRecording).toHaveBeenCalledWith(cameraId, false);
    expect(detector.getState(cameraId)).toBeUndefined(); // Reset to IDLE
  });
});
