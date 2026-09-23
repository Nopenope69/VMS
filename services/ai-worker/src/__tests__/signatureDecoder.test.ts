import { SignatureDecoder } from '../signatureDecoder';
import { ModelSignature, ModelClassMapping, ModelThresholds, FrameGeometry } from '../types';
import { CoordinateTransformer } from '../coordinateTransformer';

describe('SignatureDecoder', () => {
  const modelSignature: ModelSignature = {
    input: {
      name: 'images',
      shape: [1, 3, 640, 640],
      dtype: 'float32',
    },
    output: {
      name: 'output0',
      shape: [1, 6, 10], // 10 candidate boxes, 6 features (cx, cy, w, h, person_score, vehicle_score)
      dtype: 'float32',
    },
    coordinateFormat: 'cxcywh',
    hasObjectness: false,
    classCount: 2,
  };

  const classMapping: ModelClassMapping = {
    '0': 'person',
    '1': 'vehicle',
  };

  const thresholds: ModelThresholds = {
    person: 0.45,
    vehicle: 0.50,
  };

  it('decodes transposed model output [1, 6, 10] correctly with threshold filtering', () => {
    // 6 rows x 10 cols = 60 floats
    const data = new Float32Array(60);

    // Box 0: person at (cx=320, cy=320, w=100, h=200), person_score=0.85, vehicle_score=0.1
    const numBoxes = 10;
    // Row 0 (cx)
    data[0 * numBoxes + 0] = 320;
    // Row 1 (cy)
    data[1 * numBoxes + 0] = 320;
    // Row 2 (w)
    data[2 * numBoxes + 0] = 100;
    // Row 3 (h)
    data[3 * numBoxes + 0] = 200;
    // Row 4 (person score)
    data[4 * numBoxes + 0] = 0.85;
    // Row 5 (vehicle score)
    data[5 * numBoxes + 0] = 0.10;

    // Box 1: low confidence person (score=0.30 < threshold 0.45) -> MUST BE FILTERED OUT
    data[0 * numBoxes + 1] = 100;
    data[1 * numBoxes + 1] = 100;
    data[2 * numBoxes + 1] = 50;
    data[3 * numBoxes + 1] = 50;
    data[4 * numBoxes + 1] = 0.30;
    data[5 * numBoxes + 1] = 0.05;

    // Box 2: vehicle at (cx=500, cy=400, w=150, h=120), vehicle_score=0.92
    data[0 * numBoxes + 2] = 500;
    data[1 * numBoxes + 2] = 400;
    data[2 * numBoxes + 2] = 150;
    data[3 * numBoxes + 2] = 120;
    data[4 * numBoxes + 2] = 0.05;
    data[5 * numBoxes + 2] = 0.92;

    const detections = SignatureDecoder.decode(data, modelSignature, classMapping, thresholds);

    expect(detections).toHaveLength(2);

    const person = detections.find((d) => d.label === 'person');
    expect(person).toBeDefined();
    expect(person!.confidence).toBe(0.85);
    // cx=320/640=0.5, cy=320/640=0.5, w=100/640=0.15625, h=200/640=0.3125
    // x = 0.5 - 0.15625/2 = 0.421875, y = 0.5 - 0.3125/2 = 0.34375
    expect(person!.box.x).toBeCloseTo(0.4219, 3);
    expect(person!.box.y).toBeCloseTo(0.3438, 3);

    const vehicle = detections.find((d) => d.label === 'vehicle');
    expect(vehicle).toBeDefined();
    expect(vehicle!.confidence).toBe(0.92);
  });

  it('reverses letterbox padding and scaling when FrameGeometry is provided', () => {
    const geometry: FrameGeometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

    const data = new Float32Array(60);
    const numBoxes = 10;
    // Box 0: cx=320, cy=320, w=100, h=100, person_score=0.9
    data[0 * numBoxes + 0] = 320;
    data[1 * numBoxes + 0] = 320;
    data[2 * numBoxes + 0] = 100;
    data[3 * numBoxes + 0] = 100;
    data[4 * numBoxes + 0] = 0.90;
    data[5 * numBoxes + 0] = 0.0;

    const detections = SignatureDecoder.decode(
      data,
      modelSignature,
      classMapping,
      thresholds,
      undefined,
      geometry
    );

    expect(detections).toHaveLength(1);
    const det = detections[0];
    expect(det.label).toBe('person');
    // Normalized in source camera coordinate space [0..1]
    expect(det.box.x).toBeGreaterThan(0);
    expect(det.box.y).toBeGreaterThan(0);
    expect(det.box.width).toBeGreaterThan(0);
    expect(det.box.height).toBeGreaterThan(0);
  });

  it('throws when buffer size does not match signature shape', () => {
    const mismatchedData = new Float32Array(25);
    expect(() =>
      SignatureDecoder.decode(mismatchedData, modelSignature, classMapping, thresholds)
    ).toThrow('Model output tensor length mismatch');
  });
});
