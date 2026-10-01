/**
 * Colour attributes for confirmed-track detections (track index, Bucket 1).
 *
 * Names the dominant colour of fixed regions of a detection's box, read from the RGB24 canvas the worker already
 * holds: for a person the upper body and the lower body, for a vehicle its body panels. This is a pixel count in
 * HSV space, not a trained model, so it has no licence and no weights. It is also only as good as the light:
 *
 *   - A frame with almost no colour saturation (an IR camera at night) is reported as `monochrome: true` and gets
 *     no colour names, never a guess.
 *   - A region whose most common colour covers less than MIN_SHARE of its pixels is not named.
 *   - Accuracy on real cameras is not measured.
 *
 * The method is named in the output (`method`), so a later classifier can replace it without mixing the two.
 */
import { CanvasRegion, NormalizedBox, regionInCanvas } from './cropExtractor';
import { FrameGeometry } from './types';

export const COLOUR_METHOD = 'hsv-majority-v1';
export const COLOUR_NAMES = ['black', 'white', 'grey', 'red', 'orange', 'brown', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
export type ColourName = (typeof COLOUR_NAMES)[number];

/** A region is named only when its most common colour covers at least this share of the sampled pixels. */
export const MIN_SHARE = 0.35;
/**
 * A frame is monochrome (IR night mode) when fewer than this share of its lit pixels are clearly coloured. An IR
 * picture has almost no such pixels; a grey daytime street still has some (signs, plants, clothes, vehicles). A
 * daytime scene with nothing coloured at all is also reported as monochrome, which loses names but never invents one.
 */
export const MONOCHROME_COLOURED_SHARE = 0.01;
const COLOURED_SATURATION = 0.25;
/** Pixels sampled per region (on a grid), and for the frame-wide saturation check. */
const SAMPLES_PER_REGION = 400;
const SAMPLES_PER_FRAME = 1600;

export interface ColourAttributes {
  method: typeof COLOUR_METHOD;
  monochrome: boolean;
  /** Person: shirt or upper garment. */
  upper?: ColourName;
  /** Person: trousers, skirt or lower garment. */
  lower?: ColourName;
  /** Vehicle: body panels. */
  body?: ColourName;
}

/** The colour name of one RGB pixel (0..255). */
export function colourName(r: number, g: number, b: number): ColourName {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.2) return 'black';
  if (s < 0.18) return v > 0.8 ? 'white' : 'grey';
  const h = hue(r, g, b);
  if (h < 15 || h >= 345) return v < 0.45 ? 'brown' : 'red';
  if (h < 40) return v < 0.6 ? 'brown' : 'orange';
  if (h < 70) return v < 0.5 ? 'brown' : 'yellow';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Calls fn for about `samples` pixels on a regular grid inside the region of an RGB24 canvas. */
function sampleGrid(frame: Buffer, canvasWidth: number, r: CanvasRegion, samples: number, fn: (red: number, green: number, blue: number) => void): void {
  const step = Math.max(1, Math.floor(Math.sqrt((r.width * r.height) / samples)));
  for (let y = r.y + (step >> 1); y < r.y + r.height; y += step) {
    for (let x = r.x + (step >> 1); x < r.x + r.width; x += step) {
      const i = (y * canvasWidth + x) * 3;
      fn(frame[i], frame[i + 1], frame[i + 2]);
    }
  }
}

/** True when almost none of the canvas's lit pixels are coloured (an IR or greyscale picture), or none are lit. */
export function isMonochromeFrame(frame: Buffer, g: FrameGeometry): boolean {
  const area = regionInCanvas({ x: 0, y: 0, width: 1, height: 1 }, g);
  if (!area) return false;
  let coloured = 0;
  let lit = 0;
  sampleGrid(frame, g.modelWidth, area, SAMPLES_PER_FRAME, (r, gr, b) => {
    const max = Math.max(r, gr, b);
    if (max < 0.2 * 255) return; // dark pixels carry sensor noise, not colour
    lit++;
    if ((max - Math.min(r, gr, b)) / max >= COLOURED_SATURATION) coloured++;
  });
  return lit === 0 || coloured / lit < MONOCHROME_COLOURED_SHARE;
}

/** The most common colour of a sub-box of `box` (fractions of the box), or undefined when no colour dominates. */
function dominantColour(frame: Buffer, g: FrameGeometry, box: NormalizedBox, part: { x0: number; x1: number; y0: number; y1: number }): ColourName | undefined {
  const sub = { x: box.x + box.width * part.x0, y: box.y + box.height * part.y0, width: box.width * (part.x1 - part.x0), height: box.height * (part.y1 - part.y0) };
  const region = regionInCanvas(sub, g);
  if (!region) return undefined;
  const counts = new Map<ColourName, number>();
  let n = 0;
  sampleGrid(frame, g.modelWidth, region, SAMPLES_PER_REGION, (r, gr, b) => {
    const c = colourName(r, gr, b);
    counts.set(c, (counts.get(c) || 0) + 1);
    n++;
  });
  if (n === 0) return undefined;
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count / n >= MIN_SHARE ? best : undefined;
}

// Regions as fractions of the box. Person: below the head to the waist, and the legs above the feet.
// Vehicle: the middle band, below most windows and above the wheels and the road.
const PERSON_UPPER = { x0: 0.25, x1: 0.75, y0: 0.2, y1: 0.5 };
const PERSON_LOWER = { x0: 0.25, x1: 0.75, y0: 0.55, y1: 0.85 };
const VEHICLE_BODY = { x0: 0.2, x1: 0.8, y0: 0.45, y1: 0.75 };

const VEHICLE_CLASSES = new Set(['car', 'bus', 'truck', 'motorcycle', 'bicycle']);

/**
 * Colour attributes of one detection, or null when its class has no colour regions or its box is too small.
 * `monochrome` is computed once per frame by the caller (isMonochromeFrame) and passed in.
 */
export function describeColours(frame: Buffer, g: FrameGeometry, box: NormalizedBox, objectClass: string | undefined, monochrome: boolean): ColourAttributes | null {
  if (frame.length !== g.modelWidth * g.modelHeight * 3) {
    throw new Error(`frame is ${frame.length} bytes, the ${g.modelWidth}x${g.modelHeight} RGB24 canvas is ${g.modelWidth * g.modelHeight * 3}`);
  }
  if (!objectClass || !(objectClass === 'person' || VEHICLE_CLASSES.has(objectClass))) return null;
  if (!regionInCanvas(box, g)) return null;
  if (monochrome) return { method: COLOUR_METHOD, monochrome: true };
  const out: ColourAttributes = { method: COLOUR_METHOD, monochrome: false };
  if (objectClass === 'person') {
    const upper = dominantColour(frame, g, box, PERSON_UPPER);
    const lower = dominantColour(frame, g, box, PERSON_LOWER);
    if (upper) out.upper = upper;
    if (lower) out.lower = lower;
  } else {
    const body = dominantColour(frame, g, box, VEHICLE_BODY);
    if (body) out.body = body;
  }
  return out;
}
