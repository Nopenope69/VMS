#!/usr/bin/env python3
"""
P2.7 tracker validation reference. Generates seeded synthetic trajectories, turns them into noisy
per-frame detections (with drop-outs), and runs Roboflow supervision (MIT):

  - sv.ByteTrack on the detections  -> per-frame tracker ids
  - sv.LineZone (CENTER anchor)     -> in/out crossing counts of a horizontal line

Writes services/ai-worker/src/__tests__/fixtures/tracker/reference.json. The TypeScript test feeds
the same detections to MultiObjectTracker and the SpatialEngine tripwire and compares identity
metrics and crossing counts against these numbers within the tolerances documented in
docs/ai/TRACKER_VALIDATION.md.

  python3 tools/reference/tracker_reference.py
"""
import json
import os

import numpy as np
import supervision as sv

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'services', 'ai-worker', 'src', '__tests__', 'fixtures', 'tracker', 'reference.json')
W = H = 1000.0  # pixel canvas for supervision; the TS side uses the same values normalized
FPS = 5


def box(cx, cy, w, h):
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]


def scenario(name, objects, frames, seed, noise_px=4.0, drop_prob=0.0):
    """objects: list of dict(gt, cls, start, end, p0, v, size). Positions in pixels."""
    rng = np.random.default_rng(seed)
    out_frames = []
    for f in range(frames):
        dets = []
        for o in objects:
            if not (o['start'] <= f <= o['end']):
                continue
            if drop_prob and rng.random() < drop_prob and f not in (o['start'], o['end']):
                continue  # detector miss
            t = f - o['start']
            cx = o['p0'][0] + o['v'][0] * t + rng.normal(0, noise_px)
            cy = o['p0'][1] + o['v'][1] * t + rng.normal(0, noise_px)
            w, h = o['size']
            x1, y1, x2, y2 = box(cx, cy, w, h)
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(W, x2), min(H, y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            dets.append({'gt': o['gt'], 'cls': o['cls'], 'conf': round(float(0.6 + 0.35 * rng.random()), 4),
                         'xyxy': [round(float(v), 3) for v in (x1, y1, x2, y2)]})
        out_frames.append(dets)
    return {'name': name, 'frames': out_frames}


SCENARIOS = [
    scenario('single_walker_crossing', [
        dict(gt=1, cls='person', start=0, end=39, p0=(500, 900), v=(0, -20), size=(80, 180)),
    ], 40, seed=1),
    scenario('two_walkers_opposite_directions', [
        dict(gt=1, cls='person', start=0, end=39, p0=(300, 900), v=(0, -20), size=(80, 180)),
        dict(gt=2, cls='person', start=0, end=39, p0=(700, 100), v=(0, 20), size=(80, 180)),
    ], 40, seed=2),
    scenario('crossing_paths', [
        dict(gt=1, cls='person', start=0, end=39, p0=(150, 500), v=(18, 0), size=(80, 180)),
        dict(gt=2, cls='person', start=0, end=39, p0=(850, 520), v=(-18, 0), size=(80, 180)),
    ], 40, seed=3),
    scenario('detector_dropouts', [
        dict(gt=1, cls='person', start=0, end=39, p0=(500, 900), v=(0, -20), size=(80, 180)),
        dict(gt=2, cls='car', start=5, end=39, p0=(100, 300), v=(20, 0), size=(220, 120)),
    ], 40, seed=4, drop_prob=0.15),
    scenario('person_beside_vehicle', [
        dict(gt=1, cls='person', start=0, end=29, p0=(450, 900), v=(0, -25), size=(80, 180)),
        dict(gt=2, cls='car', start=0, end=29, p0=(520, 900), v=(0, -25), size=(220, 140)),
    ], 30, seed=5),
    scenario('loiter_near_line_no_crossing', [
        dict(gt=1, cls='person', start=0, end=39, p0=(500, 560), v=(0.5, 0), size=(80, 180)),
    ], 40, seed=6, noise_px=3.0),
]

CLS_ID = {'person': 0, 'car': 1}


def run(sc):
    tracker = sv.ByteTrack(track_activation_threshold=0.25, lost_track_buffer=15, minimum_matching_threshold=0.8,
                           frame_rate=FPS, minimum_consecutive_frames=2)
    line = sv.LineZone(start=sv.Point(0, 500), end=sv.Point(1000, 500), triggering_anchors=[sv.Position.CENTER])
    ids_per_frame = []
    for dets in sc['frames']:
        if dets:
            d = sv.Detections(xyxy=np.array([x['xyxy'] for x in dets], dtype=float),
                              confidence=np.array([x['conf'] for x in dets], dtype=float),
                              class_id=np.array([CLS_ID[x['cls']] for x in dets], dtype=int),
                              data={'gt': np.array([x['gt'] for x in dets])})
        else:
            d = sv.Detections.empty()
            d.data['gt'] = np.array([], dtype=int)
        tracked = tracker.update_with_detections(d)
        line.trigger(tracked)
        ids_per_frame.append([{'gt': int(g), 'trackId': int(t)} for g, t in zip(tracked.data.get('gt', []), tracked.tracker_id)])
    # Identity metrics vs ground truth
    per_gt = {}
    switches = 0
    last = {}
    for frame in ids_per_frame:
        for e in frame:
            per_gt.setdefault(e['gt'], set()).add(e['trackId'])
            if e['gt'] in last and last[e['gt']] != e['trackId']:
                switches += 1
            last[e['gt']] = e['trackId']
    return {
        'idSwitches': switches,
        'uniqueIdsPerGt': {str(k): len(v) for k, v in sorted(per_gt.items())},
        'lineIn': int(line.in_count),
        'lineOut': int(line.out_count),
    }


def main():
    doc = {
        'generator': 'tools/reference/tracker_reference.py',
        'supervisionVersion': sv.__version__,
        'canvas': {'width': W, 'height': H},
        'fps': FPS,
        'line': {'start': [0, 500], 'end': [1000, 500], 'anchor': 'CENTER'},
        'scenarios': [],
    }
    for sc in SCENARIOS:
        doc['scenarios'].append({**sc, 'supervision': run(sc)})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f)
    for s in doc['scenarios']:
        print(s['name'], s['supervision'])


if __name__ == '__main__':
    main()
