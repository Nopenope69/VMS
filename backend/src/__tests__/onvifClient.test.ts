import { OnvifClientManager, OnvifCredentials } from '../services/onvif/client';

// Mock Cam implementation
const mockCamConstructor = jest.fn();

jest.mock('onvif', () => ({
  Cam: jest.fn().mockImplementation(function (options: any, callback: any) {
    return mockCamConstructor(options, callback);
  }),
}));

describe('Phase 5: ONVIF Client Deep Module & PTZ Control Suite', () => {
  let manager: OnvifClientManager;

  const testCreds: OnvifCredentials = {
    hostname: '192.168.1.120',
    port: 80,
    username: 'admin',
    password: 'CameraPassword123!',
  };

  const createMockCamInstance = (overrides: any = {}) => {
    const defaultProfiles = [
      { $: { token: 'Profile_1' }, name: 'MainStream' },
      { $: { token: 'Profile_2' }, name: 'SubStream' },
    ];

    const cam: any = {
      profiles: defaultProfiles,
      capabilities: { PTZ: true },
      getDeviceInformation: jest.fn((cb) =>
        setImmediate(() =>
          cb(null, {
            manufacturer: 'Hikvision',
            model: 'DS-2CD2043G2-I',
            firmwareVersion: 'V5.5.80',
            serialNumber: 'DS123456789',
            hardwareId: 'HW-001',
          })
        )
      ),
      getStreamUri: jest.fn((options, cb) => {
        const streamPath = options.profileToken === 'Profile_2' ? 'Streaming/Channels/102' : 'Streaming/Channels/101';
        setImmediate(() => cb(null, { uri: `rtsp://192.168.1.120:554/${streamPath}` }));
      }),
      continuousMove: jest.fn((options, cb) => setImmediate(() => cb(null))),
      stop: jest.fn((options, cb) => setImmediate(() => cb(null))),
      getPresets: jest.fn((options, cb) =>
        setImmediate(() =>
          cb(null, {
            Preset1: { $: { token: 'Preset1' }, name: 'Gate_North' },
            Preset2: { $: { token: 'Preset2' }, name: 'Gate_South' },
          })
        )
      ),
      setPreset: jest.fn((options, cb) =>
        setImmediate(() =>
          cb(null, { setPresetResponse: { presetToken: 'Preset_Generated_99' } })
        )
      ),
      gotoPreset: jest.fn((options, cb) => setImmediate(() => cb(null))),
      removePreset: jest.fn((options, cb) => setImmediate(() => cb(null))),
      ...overrides,
    };
    return cam;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new OnvifClientManager();
  });

  describe('Connection Lifecycle & Cache TTL Invariants', () => {
    it('creates a new Cam instance on first connection and caches it for subsequent calls', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const cam1 = await manager.getCam(testCreds);
      expect(mockCamConstructor).toHaveBeenCalledTimes(1);
      expect(cam1).toBe(mockCam);

      // Second call with same credentials should reuse cached Cam instance
      const cam2 = await manager.getCam(testCreds);
      expect(mockCamConstructor).toHaveBeenCalledTimes(1);
      expect(cam2).toBe(mockCam);
    });

    it('expires cached Cam instance after 5-minute TTL and recreates connection', async () => {
      const mockCam1 = createMockCamInstance();
      const mockCam2 = createMockCamInstance();

      mockCamConstructor
        .mockImplementationOnce((opts, cb) => {
          cb(null);
          return mockCam1;
        })
        .mockImplementationOnce((opts, cb) => {
          cb(null);
          return mockCam2;
        });

      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = jest.fn(() => currentTime);

      try {
        const cam1 = await manager.getCam(testCreds);
        expect(cam1).toBe(mockCam1);
        expect(mockCamConstructor).toHaveBeenCalledTimes(1);

        // Advance time by 5 minutes + 1 second (300,001 ms)
        currentTime += 5 * 60 * 1000 + 1000;

        const cam2 = await manager.getCam(testCreds);
        expect(cam2).toBe(mockCam2);
        expect(mockCamConstructor).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = originalNow;
      }
    });

    it('rejects with descriptive error if ONVIF connection fails', async () => {
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(new Error('ECONNREFUSED'));
        return {};
      });

      await expect(manager.getCam(testCreds)).rejects.toThrow(
        'ONVIF connection to 192.168.1.120:80 failed: ECONNREFUSED'
      );
    });
  });

  describe('Device Information & Stream Resolution', () => {
    it('parses device information correctly from ONVIF camera response', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const info = await manager.getDeviceInformation(testCreds);
      expect(info).toEqual({
        manufacturer: 'Hikvision',
        model: 'DS-2CD2043G2-I',
        firmwareVersion: 'V5.5.80',
        serialNumber: 'DS123456789',
        hardwareId: 'HW-001',
      });
    });

    it('falls back to safe generic device info if getDeviceInformation errors', async () => {
      const mockCam = createMockCamInstance({
        getDeviceInformation: jest.fn((cb) => cb(new Error('WSDL Fault'), null)),
      });
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const info = await manager.getDeviceInformation(testCreds);
      expect(info.manufacturer).toBe('Generic ONVIF');
      expect(info.model).toBe('Camera');
      expect(info.firmwareVersion).toBe('1.0.0');
    });

    it('resolves main & sub stream URIs, embeds credentials, and identifies PTZ support', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const streams = await manager.resolveStreamUris(testCreds);

      // Embedded URL check
      expect(streams.mainStreamUri).toBe(
        'rtsp://admin:CameraPassword123!@192.168.1.120:554/Streaming/Channels/101'
      );
      expect(streams.subStreamUri).toBe(
        'rtsp://admin:CameraPassword123!@192.168.1.120:554/Streaming/Channels/102'
      );
      expect(streams.hasPtz).toBe(true);
      expect(streams.profiles).toEqual([
        { token: 'Profile_1', name: 'MainStream' },
        { token: 'Profile_2', name: 'SubStream' },
      ]);
    });

    it('throws error when camera reports zero media profiles', async () => {
      const mockCam = createMockCamInstance({ profiles: [] });
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      await expect(manager.resolveStreamUris(testCreds)).rejects.toThrow(
        'No ONVIF media profiles found on device 192.168.1.120'
      );
    });
  });

  describe('PTZ Velocity Control & Preset Management', () => {
    it('executes continuousMove with correct velocity parameters', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      await manager.ptzContinuousMove(testCreds, 'Profile_1', { x: 0.5, y: -0.2, zoom: 0.1 });

      expect(mockCam.continuousMove).toHaveBeenCalledWith(
        {
          profileToken: 'Profile_1',
          velocity: { x: 0.5, y: -0.2, zoom: 0.1 },
        },
        expect.any(Function)
      );
    });

    it('executes ptzStop with panTilt and zoom set to true', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      await manager.ptzStop(testCreds, 'Profile_1');

      expect(mockCam.stop).toHaveBeenCalledWith(
        {
          profileToken: 'Profile_1',
          panTilt: true,
          zoom: true,
        },
        expect.any(Function)
      );
    });

    it('retrieves and parses camera presets into standard format', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const presets = await manager.getPresets(testCreds, 'Profile_1');
      expect(presets).toHaveLength(2);
      expect(presets).toContainEqual({ token: 'Preset1', name: 'Gate_North' });
      expect(presets).toContainEqual({ token: 'Preset2', name: 'Gate_South' });
    });

    it('sets, navigates to, and removes presets', async () => {
      const mockCam = createMockCamInstance();
      mockCamConstructor.mockImplementation((opts, cb) => {
        cb(null);
        return mockCam;
      });

      const newPresetToken = await manager.setPreset(testCreds, 'Profile_1', 'Checkpoint');
      expect(newPresetToken).toBe('Preset_Generated_99');
      expect(mockCam.setPreset).toHaveBeenCalledWith(
        expect.objectContaining({ profileToken: 'Profile_1', presetName: 'Checkpoint' }),
        expect.any(Function)
      );

      await manager.gotoPreset(testCreds, 'Profile_1', newPresetToken, 0.8);
      expect(mockCam.gotoPreset).toHaveBeenCalledWith(
        { profileToken: 'Profile_1', preset: 'Preset_Generated_99', speed: 0.8 },
        expect.any(Function)
      );

      await manager.removePreset(testCreds, 'Profile_1', newPresetToken);
      expect(mockCam.removePreset).toHaveBeenCalledWith(
        { profileToken: 'Profile_1', presetToken: 'Preset_Generated_99' },
        expect.any(Function)
      );
    });
  });
});
