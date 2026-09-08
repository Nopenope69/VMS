import { VehicleCategory, WatchlistCategory, EventSeverity } from '@prisma/client';
import { PlateTrackAggregatorService } from '../services/anpr/plateTrackAggregator.service';
import alarmService from '../services/alarm/alarm.service';

jest.mock('../services/alarm/alarm.service');

describe('PlateTrackAggregatorService - Indian ANPR Multi-Frame Engine', () => {
  let service: PlateTrackAggregatorService;
  let mockPrisma: any;
  let observationStore: any[] = [];
  let watchlistStore: any[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    observationStore = [];
    watchlistStore = [];

    mockPrisma = {
      vehicleWatchlist: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            watchlistStore.find(
              (w) => w.tenantId === where.tenantId && w.normalizedPlate === where.normalizedPlate && w.active
            ) || null
          );
        }),
      },
      vehicleObservation: {
        create: jest.fn().mockImplementation(({ data }) => {
          const item = { id: `obs_${observationStore.length + 1}`, ...data };
          observationStore.push(item);
          return Promise.resolve(item);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = observationStore.findIndex((o) => o.id === where.id);
          if (idx >= 0) {
            observationStore[idx] = { ...observationStore[idx], ...data };
            return Promise.resolve(observationStore[idx]);
          }
          return Promise.resolve(null);
        }),
      },
    };

    service = new PlateTrackAggregatorService(mockPrisma);
  });

  afterEach(() => {
    service.stop();
  });

  describe('Indian Plate Format Parsing & Positional OCR Normalization', () => {
    it('accurately parses standard Delhi, Maharashtra, Karnataka, and UP plates', () => {
      const p1 = PlateTrackAggregatorService.normalizeIndianPlate('DL 01 AB 1234');
      expect(p1.isValidFormat).toBe(true);
      expect(p1.stateCode).toBe('DL');
      expect(p1.normalizedPlate).toBe('DL01AB1234');

      const p2 = PlateTrackAggregatorService.normalizeIndianPlate('mh-12-de-5678');
      expect(p2.isValidFormat).toBe(true);
      expect(p2.stateCode).toBe('MH');
      expect(p2.normalizedPlate).toBe('MH12DE5678');

      const p3 = PlateTrackAggregatorService.normalizeIndianPlate('KA05MN9012');
      expect(p3.isValidFormat).toBe(true);
      expect(p3.stateCode).toBe('KA');
    });

    it('accurately identifies and validates pan-India Bharat (BH) series', () => {
      const bh = PlateTrackAggregatorService.normalizeIndianPlate('22 BH 1234 AA');
      expect(bh.isValidFormat).toBe(true);
      expect(bh.stateCode).toBe('BH');
      expect(bh.normalizedPlate).toBe('22BH1234AA');
    });

    it('corrects positional OCR character confusions (0/O, 1/I in state/district slots)', () => {
      // "D0 01 AB 1234" -> 0 in slot 1 should become letter 'L' or if state code has 'O'/'I'
      // Example: "0L 01 AB 1234" -> 0 in slot 0 should become letter 'D'/'O'
      // Example: "DL O1 AB I234" -> O in district slot becomes 0, I in last 4 digits becomes 1
      const corrected = PlateTrackAggregatorService.normalizeIndianPlate('DL O1 AB I234');
      expect(corrected.normalizedPlate).toBe('DL01AB1234');
      expect(corrected.stateCode).toBe('DL');
      expect(corrected.isValidFormat).toBe(true);
    });
  });

  describe('Multi-Frame Temporal Voting Consensus', () => {
    it('resolves multi-frame noise into correct plate consensus', () => {
      const frames = [
        { tenantId: 't1', cameraId: 'c1', plateText: 'KA01AB1284', confidence: 0.75 },
        { tenantId: 't1', cameraId: 'c1', plateText: 'KA01AB1234', confidence: 0.94 },
        { tenantId: 't1', cameraId: 'c1', plateText: 'KA01AB1234', confidence: 0.91 },
        { tenantId: 't1', cameraId: 'c1', plateText: 'KA01AB1284', confidence: 0.72 },
        { tenantId: 't1', cameraId: 'c1', plateText: 'KA01AB1234', confidence: 0.89 },
      ];

      const consensus = PlateTrackAggregatorService.voteConsensus(frames);
      expect(consensus).toBe('KA01AB1234');
    });
  });

  describe('Vehicle Observation Session Deduplication', () => {
    it('deduplicates multiple readings of the same track into one VehicleObservation session', async () => {
      const tId = 'tenant_01';
      const cId = 'cam_toll_01';
      const trackId = 'veh_track_99';

      // Frame 1
      const res1 = await service.processDetection({
        tenantId: tId,
        cameraId: cId,
        trackId,
        plateText: 'HR26DQ5555',
        confidence: 0.82,
        vehicleCategory: VehicleCategory.FOUR_WHEELER,
      });

      expect(res1.normalizedPlate).toBe('HR26DQ5555');
      expect(observationStore).toHaveLength(1);
      expect(observationStore[0].observationCount).toBe(1);

      // Frame 2 (same track, higher confidence)
      const res2 = await service.processDetection({
        tenantId: tId,
        cameraId: cId,
        trackId,
        plateText: 'HR26DQ5555',
        confidence: 0.96,
        vehicleCategory: VehicleCategory.FOUR_WHEELER,
      });

      expect(res2.confidence).toBe(0.96);
      expect(observationStore).toHaveLength(1); // Deduped! Still 1 row
      expect(observationStore[0].observationCount).toBe(2);
      expect(observationStore[0].bestConfidence).toBe(0.96);
    });
  });

  describe('Watchlist Alerting & Alarm Integration', () => {
    it('triggers CRITICAL Alarm on Blacklisted vehicle detection', async () => {
      const tId = 'tenant_01';
      const cId = 'cam_toll_01';

      watchlistStore.push({
        id: 'wl_black_01',
        tenantId: tId,
        plateNumber: 'UP16AK1111',
        normalizedPlate: 'UP16AK1111',
        category: WatchlistCategory.BLACKLIST,
        notes: 'Stolen vehicle reported by state police',
        alertOnMatch: true,
        severity: EventSeverity.CRITICAL,
        active: true,
      });

      (alarmService.createAlarm as jest.Mock).mockResolvedValue({ id: 'alarm_wl_01' });

      const res = await service.processDetection({
        tenantId: tId,
        cameraId: cId,
        trackId: 'track_suspect_01',
        plateText: 'UP16AK1111',
        confidence: 0.95,
        snapshotPath: '/snapshots/up16.jpg',
      });

      expect(res.matchedWatchlist).toBeDefined();
      expect(res.matchedWatchlist?.category).toBe(WatchlistCategory.BLACKLIST);
      expect(alarmService.createAlarm).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: tId,
          cameraId: cId,
          severity: EventSeverity.CRITICAL,
          title: expect.stringContaining('BLACKLIST Vehicle [UP16AK1111] Detected'),
        })
      );
    });
  });
});
