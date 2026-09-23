import { computeIoU, classScopedNms } from '../classScopedNms';
import { RawDetection } from '../types';

describe('Class-Scoped Non-Maximum Suppression (NMS)', () => {
  describe('computeIoU', () => {
    it('returns 1.0 for identical boxes', () => {
      const box = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
      expect(computeIoU(box, box)).toBeCloseTo(1.0, 5);
    });

    it('returns 0.0 for completely disjoint boxes', () => {
      const boxA = { x: 0.0, y: 0.0, width: 0.2, height: 0.2 };
      const boxB = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
      expect(computeIoU(boxA, boxB)).toBe(0.0);
    });

    it('computes accurate IoU for partially overlapping boxes', () => {
      // Box A: [0, 0, 10, 10] -> area 100
      // Box B: [5, 0, 10, 10] -> area 100
      // Intersection: [5, 0, 5, 10] -> area 50
      // Union: 100 + 100 - 50 = 150
      // IoU = 50 / 150 = 0.33333
      const boxA = { x: 0.0, y: 0.0, width: 0.1, height: 0.1 };
      const boxB = { x: 0.05, y: 0.0, width: 0.1, height: 0.1 };
      expect(computeIoU(boxA, boxB)).toBeCloseTo(50 / 150, 4);
    });
  });

  describe('classScopedNms', () => {
    it('suppresses lower-confidence boxes of the same class when IoU >= threshold', () => {
      const detections: RawDetection[] = [
        {
          classId: 0,
          label: 'person',
          confidence: 0.92,
          box: { x: 0.1, y: 0.1, width: 0.3, height: 0.6 },
        },
        {
          classId: 0,
          label: 'person',
          confidence: 0.75, // Overlaps heavily with 0.92 box -> should be suppressed
          box: { x: 0.12, y: 0.11, width: 0.29, height: 0.59 },
        },
        {
          classId: 0,
          label: 'person',
          confidence: 0.88, // Disjoint person -> should be preserved
          box: { x: 0.6, y: 0.1, width: 0.3, height: 0.6 },
        },
      ];

      const result = classScopedNms(detections, 0.45);
      expect(result).toHaveLength(2);
      expect(result.map((d) => d.confidence)).toEqual(expect.arrayContaining([0.92, 0.88]));
    });

    it('suppresses lower-confidence vehicle boxes of the same class', () => {
      const detections: RawDetection[] = [
        {
          classId: 2,
          label: 'vehicle',
          confidence: 0.85,
          box: { x: 0.2, y: 0.3, width: 0.5, height: 0.4 },
        },
        {
          classId: 2,
          label: 'vehicle',
          confidence: 0.65, // Overlapping vehicle
          box: { x: 0.22, y: 0.31, width: 0.48, height: 0.39 },
        },
      ];

      const result = classScopedNms(detections, 0.45);
      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe(0.85);
    });

    it('PRESERVES overlapping boxes between DIFFERENT classes (person vs vehicle)', () => {
      // In real-world surveillance, a person may be standing right in front of or inside a vehicle
      // They share the exact same bounding box spatial region.
      // Under class-scoped NMS, BOTH must be preserved.
      const detections: RawDetection[] = [
        {
          classId: 2,
          label: 'vehicle',
          confidence: 0.95,
          box: { x: 0.3, y: 0.3, width: 0.4, height: 0.5 },
        },
        {
          classId: 0,
          label: 'person',
          confidence: 0.80,
          // Highly overlapping bounding box with vehicle!
          box: { x: 0.32, y: 0.31, width: 0.38, height: 0.49 },
        },
      ];

      const result = classScopedNms(detections, 0.45);
      expect(result).toHaveLength(2);
      const labels = result.map((d) => d.label);
      expect(labels).toContain('vehicle');
      expect(labels).toContain('person');
    });

    it('returns empty array when given empty input', () => {
      expect(classScopedNms([])).toEqual([]);
    });
  });
});
