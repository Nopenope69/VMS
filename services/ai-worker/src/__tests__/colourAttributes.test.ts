/**
 * Colour attributes (track index): pixel naming, person and vehicle regions on a real letterboxed canvas, the IR
 * (monochrome) refusal, the share threshold, and the AiWorker attaching them to CONFIRMED detections.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COLOUR_METHOD, colourName, describeColours, isMonochromeFrame } from '../colourAttributes';
import { CoordinateTransformer } from '../coordinateTransformer';
import { regionInCanvas } from '../cropExtractor';
import { AiWorker } from '../worker';
import { FrameGeometry, ModelManifestRecord, VideoFrame } from '../types';

type RGB = [number, number, number];
const BLUE: RGB = [30, 60, 200];
const BLACK: RGB = [15, 15, 18];
const WHITE: RGB = [235, 235, 240];
const RED: RGB = [200, 30, 35];
const SKIN: RGB = [190, 140, 110];
const ROAD: RGB = [110, 110, 105];

// A 1920x1080 camera letterboxed into a 640x640 model canvas (pad above and below), as in the stream pipeline.
const g: FrameGeometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

function canvas(fill: RGB): Buffer {
  const b = Buffer.alloc(g.modelWidth * g.modelHeight * 3);
  for (let i = 0; i < b.length; i += 3) [b[i], b[i + 1], b[i + 2]] = fill;
  return b;
}
/** Paints a source-normalised box onto the canvas through the frame geometry (as the camera would show it). */
function paint(b: Buffer, box: { x: number; y: number; width: number; height: number }, rgb: RGB) {
  const r = regionInCanvas(box, g)!;
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) [b[(y * g.modelWidth + x) * 3], b[(y * g.modelWidth + x) * 3 + 1], b[(y * g.modelWidth + x) * 3 + 2]] = rgb;
}
const person = { x: 0.4, y: 0.3, width: 0.1, height: 0.5 };
/** A person: head, blue shirt (top half), black trousers (bottom half), on a grey road. */
function personScene(shirt: RGB = BLUE, trousers: RGB = BLACK): Buffer {
  const b = canvas(ROAD);
  paint(b, { x: person.x, y: person.y, width: person.width, height: person.height * 0.15 }, SKIN);
  paint(b, { x: person.x, y: person.y + person.height * 0.15, width: person.width, height: person.height * 0.4 }, shirt);
  paint(b, { x: person.x, y: person.y + person.height * 0.55, width: person.width, height: person.height * 0.45 }, trousers);
  return b;
}

describe('colourName', () => {
  it.each([
    [[0, 0, 0], 'black'],
    [[250, 250, 250], 'white'],
    [[128, 128, 128], 'grey'],
    [[220, 20, 20], 'red'],
    [[240, 140, 20], 'orange'],
    [[120, 70, 30], 'brown'],
    [[230, 220, 30], 'yellow'],
    [[30, 180, 60], 'green'],
    [[30, 60, 200], 'blue'],
    [[130, 40, 200], 'purple'],
    [[230, 60, 160], 'pink'],
  ])('%j is %s', (rgb, name) => {
    expect(colourName(...(rgb as RGB))).toBe(name);
  });
});

describe('describeColours', () => {
  it('names a person\'s upper and lower garments from the letterboxed canvas', () => {
    const b = personScene();
    expect(describeColours(b, g, person, 'person', isMonochromeFrame(b, g))).toEqual({ method: COLOUR_METHOD, monochrome: false, upper: 'blue', lower: 'black' });
    const b2 = personScene(RED, WHITE);
    expect(describeColours(b2, g, person, 'person', false)).toMatchObject({ upper: 'red', lower: 'white' });
  });

  it('names a vehicle\'s body colour from the middle band', () => {
    const b = canvas(ROAD);
    const car = { x: 0.2, y: 0.5, width: 0.3, height: 0.2 };
    paint(b, car, WHITE);
    paint(b, { x: car.x + car.width * 0.25, y: car.y, width: car.width * 0.5, height: car.height * 0.35 }, BLACK); // windows
    expect(describeColours(b, g, car, 'car', false)).toEqual({ method: COLOUR_METHOD, monochrome: false, body: 'white' });
  });

  it('gives no colour names on an IR (monochrome) picture, and says so', () => {
    const b = canvas(ROAD);
    paint(b, person, [180, 180, 180]);
    expect(isMonochromeFrame(b, g)).toBe(true);
    expect(describeColours(b, g, person, 'person', true)).toEqual({ method: COLOUR_METHOD, monochrome: true });
    expect(isMonochromeFrame(personScene(), g)).toBe(false);
  });

  it('does not name a region where no colour dominates', () => {
    const b = canvas(ROAD);
    // Vertical stripes of four colours across the shirt: none reaches the share threshold.
    const stripes: RGB[] = [BLUE, RED, [30, 180, 60], [230, 220, 30]];
    for (let i = 0; i < 8; i++) paint(b, { x: person.x + (person.width / 8) * i, y: person.y, width: person.width / 8, height: person.height * 0.55 }, stripes[i % 4]);
    paint(b, { x: person.x, y: person.y + person.height * 0.55, width: person.width, height: person.height * 0.45 }, BLACK);
    const c = describeColours(b, g, person, 'person', false)!;
    expect(c.upper).toBeUndefined();
    expect(c.lower).toBe('black');
  });

  it('returns null for classes without colour regions and for boxes too small to sample', () => {
    const b = personScene();
    expect(describeColours(b, g, person, 'dog', false)).toBeNull();
    expect(describeColours(b, g, person, undefined, false)).toBeNull();
    expect(describeColours(b, g, { x: 0.5, y: 0.5, width: 0.001, height: 0.001 }, 'person', false)).toBeNull();
  });

  it('refuses a buffer that is not the canvas', () => {
    expect(() => describeColours(Buffer.alloc(10), g, person, 'person', false)).toThrow(/RGB24 canvas/);
  });
});

describe('AiWorker attaches colours to CONFIRMED detections', () => {
  const originalEnv = { ...process.env };
  let tmpDir = '';
  let artifactPath = '';
  let manifest: ModelManifestRecord;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AI_INFERENCE_MODE = 'test-stub';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-colour-'));
    artifactPath = path.join(tmpDir, 'model.onnx');
    const content = Buffer.from('mock-onnx-bytes-colour');
    fs.writeFileSync(artifactPath, content);
    manifest = {
      id: 'manifest-colour-1',
      name: 'vigilone-person-vehicle-detector',
      version: '1.0.0',
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      codeLicense: 'Apache-2.0',
      weightLicense: 'Apache-2.0',
      runtimeConfigJson: { runtime: 'onnxruntime', inputWidth: 640, inputHeight: 640, colorSpace: 'RGB', modelFormat: 'ONNX' },
      classesJson: { '0': 'person', '1': 'car' },
      thresholdsJson: { person: 0.45, car: 0.5 },
      modelSignatureJson: { input: { name: 'images', shape: [1, 3, 640, 640], dtype: 'float32' }, output: { name: 'output0', shape: [1, 6, 8400], dtype: 'float32' }, coordinateFormat: 'cxcywh', hasObjectness: false, classCount: 2 },
      isActive: true,
    };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const frame = (seq: number, data: Buffer): VideoFrame => ({
    cameraId: 'cam-colour',
    tenantId: 'tenant-1',
    streamPath: 'cam_colour',
    streamSessionId: 's',
    sequenceNumber: seq,
    sampledAt: new Date(`2026-09-29T10:00:0${seq}Z`),
    receivedAt: new Date(`2026-09-29T10:00:0${seq}Z`),
    width: 640,
    height: 640,
    channels: 3,
    data,
    geometry: g,
  });

  async function run(data: Buffer, colourAttributes?: boolean) {
    const worker = new AiWorker({ backendBaseUrl: 'http://127.0.0.1:4000', internalSecret: 's', trackerConfig: { minHitsToConfirm: 2 }, colourAttributes });
    const submitted: any[] = [];
    (worker as any).apiClient.submitDetection = jest.fn(async (e: any) => {
      submitted.push(JSON.parse(JSON.stringify(e)));
      return { success: true };
    });
    await worker.initializeModel(manifest, artifactPath);
    await worker.processFrame(frame(1, data));
    await worker.processFrame(frame(2, data));
    return { submitted, worker };
  }

  it('on by default: a colour picture gives named colours, an IR picture gives monochrome', async () => {
    const coloured = await run(canvas(BLUE));
    expect(coloured.submitted.length).toBeGreaterThan(0);
    for (const e of coloured.submitted) {
      expect(e.attributesJson.colour).toMatchObject({ method: COLOUR_METHOD, monochrome: false });
      const named = [e.attributesJson.colour.upper, e.attributesJson.colour.lower, e.attributesJson.colour.body].filter(Boolean);
      expect(named.length).toBeGreaterThan(0);
      expect(named.every((c) => c === 'blue')).toBe(true);
    }
    const ir = await run(canvas([90, 90, 90]));
    expect(ir.submitted.every((e) => e.attributesJson.colour?.monochrome === true && !e.attributesJson.colour.upper && !e.attributesJson.colour.body)).toBe(true);
  });

  it('off with colourAttributes: false', async () => {
    const { submitted } = await run(canvas(BLUE), false);
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((e) => e.attributesJson?.colour === undefined)).toBe(true);
  });

  it('a naming failure is counted and the detection is still sent without colours', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mod = require('../colourAttributes');
    jest.spyOn(mod, 'describeColours').mockImplementation(() => {
      throw new Error('colour exploded');
    });
    const { submitted, worker } = await run(canvas(BLUE));
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((e) => e.attributesJson?.colour === undefined)).toBe(true);
    expect(worker.core.metrics.render()).toMatch(/vigilone_ai_colour_attributes_total\{outcome="failed"\} [1-9]/);
  });
});
