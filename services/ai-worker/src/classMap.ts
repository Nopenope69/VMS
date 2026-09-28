import { ModelClassMapping } from './types';

/**
 * The 80 COCO detection classes in contiguous index order, as used by YOLOX and most YOLO exports
 * (index 0 = person). Source: yolox/data/datasets/coco_classes.py.
 */
export const COCO80_CLASSES: readonly string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * COCO category ids (sparse, 1..90) to names, as emitted by DETR-family exports trained on COCO
 * (RF-DETR `assets/coco_classes.py`). Category id = COCO80 index mapped through the official
 * 80->91 table.
 */
const COCO80_TO_91 = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
  64, 65, 67, 70, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 84, 85, 86, 87, 88, 89, 90,
];

export function coco80ClassMapping(): ModelClassMapping {
  const m: ModelClassMapping = {};
  COCO80_CLASSES.forEach((name, i) => (m[String(i)] = name));
  return m;
}

export function coco91ClassMapping(): ModelClassMapping {
  const m: ModelClassMapping = {};
  COCO80_CLASSES.forEach((name, i) => (m[String(COCO80_TO_91[i])] = name));
  return m;
}

/**
 * VigilOne v1 object classes (action plan section 3: person, bicycle, motorcycle, car, bus, truck)
 * and the events.v1 type each one feeds. Anything else a COCO model detects is dropped before
 * tracking: it is never tracked, stored or emitted.
 */
export const VIGILONE_V1_CLASSES = ['person', 'bicycle', 'motorcycle', 'car', 'bus', 'truck'] as const;
export type VigilOneV1Class = (typeof VIGILONE_V1_CLASSES)[number];

export function toVigilOneClass(label: string): VigilOneV1Class | null {
  const l = label.trim().toLowerCase();
  return (VIGILONE_V1_CLASSES as readonly string[]).includes(l) ? (l as VigilOneV1Class) : null;
}

/** Legacy DetectionEvent.type values used by the backend (Prisma EventType). */
export function eventTypeForClass(cls: VigilOneV1Class): 'PERSON_DETECTED' | 'VEHICLE_DETECTED' {
  return cls === 'person' ? 'PERSON_DETECTED' : 'VEHICLE_DETECTED';
}
