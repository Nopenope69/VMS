import { CoordinateTransformer } from '../coordinateTransformer';
import { FrameGeometry } from '../types';

describe('CoordinateTransformer', () => {
  describe('computeGeometry', () => {
    it('computes exact padding and scale for standard 16:9 1080p feed letterboxed to 640x640', () => {
      const geom = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

      expect(geom.sourceWidth).toBe(1920);
      expect(geom.sourceHeight).toBe(1080);
      expect(geom.modelWidth).toBe(640);
      expect(geom.modelHeight).toBe(640);
      expect(geom.scale).toBeCloseTo(640 / 1920, 4); // ~0.3333
      expect(geom.padX).toBe(0);
      expect(geom.padY).toBe(140); // (640 - 360) / 2 = 140
    });

    it('computes exact padding and scale for tall 9:16 portrait feed pillarboxed to 640x640', () => {
      const geom = CoordinateTransformer.computeGeometry(1080, 1920, 640, 640, true);

      expect(geom.scale).toBeCloseTo(640 / 1920, 4); // ~0.3333
      expect(geom.padX).toBe(140); // (640 - 360) / 2 = 140
      expect(geom.padY).toBe(0);
    });

    it('handles square 1:1 feed with zero padding', () => {
      const geom = CoordinateTransformer.computeGeometry(1000, 1000, 640, 640, true);

      expect(geom.scale).toBeCloseTo(0.64, 4);
      expect(geom.padX).toBe(0);
      expect(geom.padY).toBe(0);
    });

    it('handles letterbox=false mode without padding', () => {
      const geom = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, false);

      expect(geom.scale).toBe(1.0);
      expect(geom.padX).toBe(0);
      expect(geom.padY).toBe(0);
    });

    it('throws on invalid non-positive source or model dimensions', () => {
      expect(() => CoordinateTransformer.computeGeometry(0, 1080, 640, 640)).toThrow('Invalid source dimensions');
      expect(() => CoordinateTransformer.computeGeometry(1920, -5, 640, 640)).toThrow('Invalid source dimensions');
      expect(() => CoordinateTransformer.computeGeometry(1920, 1080, 0, 640)).toThrow('Invalid model dimensions');
    });
  });

  describe('reverseTransformBox', () => {
    const geometry16_9: FrameGeometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

    it('reverses model-space bounding box to native source-space coordinates accurately', () => {
      // Suppose an object in 640x640 model canvas occupies:
      // x: 100px (100 / 640 = 0.15625)
      // y: 200px (200 / 640 = 0.3125) -> in active region (padY = 140, so y_active = 60px)
      // w: 200px (200 / 640 = 0.3125)
      // h: 100px (100 / 640 = 0.15625)
      const modelBox = {
        x: 100 / 640,
        y: 200 / 640,
        width: 200 / 640,
        height: 100 / 640,
      };

      const reversed = CoordinateTransformer.reverseTransformBox(modelBox, geometry16_9);

      // In camera space:
      // scale = 640/1920 = 1/3
      // unpadX = 100 -> srcX = 100 / (1/3) = 300px. normX = 300 / 1920 = 0.15625
      // unpadY = 200 - 140 = 60px -> srcY = 60 / (1/3) = 180px. normY = 180 / 1080 = 0.16667
      // unpadW = 200 -> srcW = 200 / (1/3) = 600px. normW = 600 / 1920 = 0.3125
      // unpadH = 100 -> srcH = 100 / (1/3) = 300px. normH = 300 / 1080 = 0.27778
      expect(reversed.x).toBeCloseTo(0.1563, 3);
      expect(reversed.y).toBeCloseTo(0.1667, 3);
      expect(reversed.width).toBeCloseTo(0.3125, 3);
      expect(reversed.height).toBeCloseTo(0.2778, 3);
    });

    it('clamps coordinates falling into letterbox padding bands', () => {
      // Model box partially in top black pad (y = 50px < padY 140)
      const modelBox = {
        x: 0,
        y: 50 / 640,
        width: 100 / 640,
        height: 150 / 640,
      };

      const reversed = CoordinateTransformer.reverseTransformBox(modelBox, geometry16_9);
      expect(reversed.y).toBe(0); // clamped to top of active frame
      expect(reversed.x).toBe(0);
      expect(reversed.width).toBeGreaterThan(0);
      expect(reversed.height).toBeGreaterThan(0);
    });

    it('rejects frame without guessing if mandatory FrameGeometry is missing', () => {
      const modelBox = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
      expect(() => CoordinateTransformer.reverseTransformBox(modelBox, null as any)).toThrow(
        'Mandatory FrameGeometry is missing'
      );
    });
  });
});
