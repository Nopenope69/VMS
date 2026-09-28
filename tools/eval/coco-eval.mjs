#!/usr/bin/env node
/**
 * P2.8 evaluation harness: COCO-style detection metrics with no dependencies.
 *
 *   node tools/eval/coco-eval.mjs --gt annotations.json --dets detections.json \
 *        [--score-threshold 0.4] [--duration-hours 12.5] [--out metrics.json]
 *
 * gt:   COCO annotation file (images, annotations[{image_id, category_id, bbox:[x,y,w,h]}], categories)
 * dets: COCO results list [{image_id, category_id, bbox:[x,y,w,h], score}]
 *
 * AP follows pycocotools COCOeval (bbox, area 'all', maxDets 100, 101 recall points, IoU
 * .50:.05:.95); tools/eval/__tests__ checks it against pycocotools on a reference set.
 * Precision / recall / FP are reported at the operating score threshold (IoU 0.5 greedy matching);
 * FP per hour needs the footage duration the frames were sampled from (--duration-hours).
 */
import fs from 'fs';

const REC_THRS = Array.from({ length: 101 }, (_, i) => i / 100);
const IOU_THRS = Array.from({ length: 10 }, (_, i) => 0.5 + 0.05 * i);

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const iw = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const ih = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Stable descending sort by score (mergesort in pycocotools). */
const byScoreDesc = (a, b) => b.score - a.score;

/**
 * Per (image, category) matching as in COCOeval.evaluateImg for iscrowd=0 and area 'all'.
 * Returns, for each IoU threshold, a matched flag per detection (in score order).
 */
function evaluateImg(gts, dts, maxDets) {
  const d = [...dts].sort(byScoreDesc).slice(0, maxDets);
  const matched = IOU_THRS.map(() => new Array(d.length).fill(false));
  if (gts.length === 0) return { dts: d, matched };
  const ious = d.map((det) => gts.map((g) => iou(det.bbox, g.bbox)));
  IOU_THRS.forEach((t, ti) => {
    const gtm = new Array(gts.length).fill(false);
    d.forEach((_, di) => {
      let best = Math.min(t, 1 - 1e-10);
      let m = -1;
      for (let gi = 0; gi < gts.length; gi++) {
        if (gtm[gi]) continue;
        if (ious[di][gi] < best) continue;
        best = ious[di][gi];
        m = gi;
      }
      if (m === -1) return;
      gtm[m] = true;
      matched[ti][di] = true;
    });
  });
  return { dts: d, matched };
}

/** 101-point interpolated precision, as COCOeval.accumulate. */
function interpolatedAp(scoresMatched, npig) {
  if (npig === 0) return null;
  const sorted = [...scoresMatched].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  const rc = [];
  const pr = [];
  for (const s of sorted) {
    if (s.matched) tp++;
    else fp++;
    rc.push(tp / npig);
    pr.push(tp / (tp + fp + Number.EPSILON));
  }
  for (let i = pr.length - 1; i > 0; i--) if (pr[i] > pr[i - 1]) pr[i - 1] = pr[i];
  let sum = 0;
  for (const r of REC_THRS) {
    // searchsorted(rc, r, side='left')
    let lo = 0;
    let hi = rc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rc[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    sum += lo < pr.length ? pr[lo] : 0;
  }
  return sum / REC_THRS.length;
}

export function evaluate(gt, dets, opts = {}) {
  const maxDets = opts.maxDets ?? 100;
  const scoreThreshold = opts.scoreThreshold ?? 0.4;
  const durationHours = opts.durationHours ?? null;
  const cats = gt.categories.map((c) => ({ id: c.id, name: c.name }));
  const imageIds = gt.images.map((i) => i.id);
  const key = (img, cat) => `${img}:${cat}`;
  const gtBy = new Map();
  const dtBy = new Map();
  for (const a of gt.annotations) {
    if (a.iscrowd) throw new Error('crowd annotations are not supported by this harness');
    (gtBy.get(key(a.image_id, a.category_id)) || gtBy.set(key(a.image_id, a.category_id), []).get(key(a.image_id, a.category_id))).push(a);
  }
  for (const d of dets) {
    (dtBy.get(key(d.image_id, d.category_id)) || dtBy.set(key(d.image_id, d.category_id), []).get(key(d.image_id, d.category_id))).push(d);
  }

  const perClass = {};
  const apAll = [];
  const ap50All = [];
  for (const c of cats) {
    const npig = gt.annotations.filter((a) => a.category_id === c.id).length;
    const perThr = IOU_THRS.map(() => []);
    let tpOp = 0;
    let fpOp = 0;
    for (const img of imageIds) {
      const gts = gtBy.get(key(img, c.id)) || [];
      const dts = dtBy.get(key(img, c.id)) || [];
      const { dts: sorted, matched } = evaluateImg(gts, dts, maxDets);
      IOU_THRS.forEach((_, ti) => sorted.forEach((d, di) => perThr[ti].push({ score: d.score, matched: matched[ti][di] })));
      // Operating point: detections at or above the threshold, IoU 0.5.
      const op = evaluateImg(gts, dts.filter((d) => d.score >= scoreThreshold), maxDets);
      op.matched[0].forEach((m) => (m ? tpOp++ : fpOp++));
    }
    const aps = perThr.map((list) => interpolatedAp(list, npig));
    if (aps[0] === null) {
      perClass[c.name] = { categoryId: c.id, groundTruth: 0, ap: null, ap50: null, ap75: null, tp: 0, fp: fpOp, fn: 0, precision: null, recall: null };
      continue;
    }
    const ap = aps.reduce((s, v) => s + v, 0) / aps.length;
    apAll.push(ap);
    ap50All.push(aps[0]);
    perClass[c.name] = {
      categoryId: c.id,
      groundTruth: npig,
      ap: round(ap),
      ap50: round(aps[0]),
      ap75: round(aps[5]),
      tp: tpOp,
      fp: fpOp,
      fn: npig - tpOp,
      precision: tpOp + fpOp > 0 ? round(tpOp / (tpOp + fpOp)) : null,
      recall: round(tpOp / npig),
      fpPerHour: durationHours ? round(fpOp / durationHours) : null,
    };
  }
  return {
    images: imageIds.length,
    groundTruth: gt.annotations.length,
    detections: dets.length,
    scoreThreshold,
    durationHours,
    mAP: apAll.length ? round(apAll.reduce((s, v) => s + v, 0) / apAll.length) : null,
    mAP50: ap50All.length ? round(ap50All.reduce((s, v) => s + v, 0) / ap50All.length) : null,
    perClass,
  };
}

function round(v) {
  return v === null || v === undefined ? v : Math.round(v * 1e6) / 1e6;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!get('--gt') || !get('--dets')) {
    console.error('usage: coco-eval.mjs --gt annotations.json --dets detections.json [--score-threshold 0.4] [--duration-hours H] [--out file]');
    process.exit(2);
  }
  const res = evaluate(JSON.parse(fs.readFileSync(get('--gt'), 'utf8')), JSON.parse(fs.readFileSync(get('--dets'), 'utf8')), {
    scoreThreshold: get('--score-threshold') ? Number(get('--score-threshold')) : undefined,
    durationHours: get('--duration-hours') ? Number(get('--duration-hours')) : undefined,
  });
  const out = JSON.stringify(res, null, 2) + '\n';
  if (get('--out')) fs.writeFileSync(get('--out'), out);
  process.stdout.write(out);
}
