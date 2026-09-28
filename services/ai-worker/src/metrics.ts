/**
 * Minimal Prometheus text-format registry for the ai-worker (no dependency).
 * Counters, gauges and fixed-bucket histograms with label sets.
 */
type Labels = Record<string, string | number>;

function labelKey(labels?: Labels): string {
  if (!labels) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');
}

interface Family {
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  series: Map<string, number>;
  buckets?: number[];
  hist?: Map<string, { counts: number[]; sum: number; count: number }>;
}

export class MetricsRegistry {
  private families = new Map<string, Family>();

  private family(name: string, type: Family['type'], help: string, buckets?: number[]): Family {
    let f = this.families.get(name);
    if (!f) {
      f = { type, help, series: new Map(), buckets, hist: type === 'histogram' ? new Map() : undefined };
      this.families.set(name, f);
    }
    return f;
  }

  inc(name: string, help: string, labels?: Labels, by = 1): void {
    const f = this.family(name, 'counter', help);
    const k = labelKey(labels);
    f.series.set(k, (f.series.get(k) || 0) + by);
  }

  set(name: string, help: string, labels: Labels | undefined, value: number): void {
    this.family(name, 'gauge', help).series.set(labelKey(labels), value);
  }

  observe(name: string, help: string, buckets: number[], value: number, labels?: Labels): void {
    const f = this.family(name, 'histogram', help, buckets);
    const k = labelKey(labels);
    let h = f.hist!.get(k);
    if (!h) {
      h = { counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
      f.hist!.set(k, h);
    }
    buckets.forEach((le, i) => {
      if (value <= le) h!.counts[i]++;
    });
    h.sum += value;
    h.count++;
  }

  get(name: string, labels?: Labels): number | undefined {
    return this.families.get(name)?.series.get(labelKey(labels));
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, f] of this.families) {
      lines.push(`# HELP ${name} ${f.help}`);
      lines.push(`# TYPE ${name} ${f.type}`);
      if (f.type === 'histogram') {
        for (const [k, h] of f.hist!) {
          const sep = k ? ',' : '';
          f.buckets!.forEach((le, i) => lines.push(`${name}_bucket{${k}${sep}le="${le}"} ${h.counts[i]}`));
          lines.push(`${name}_bucket{${k}${sep}le="+Inf"} ${h.count}`);
          lines.push(`${name}_sum${k ? `{${k}}` : ''} ${h.sum}`);
          lines.push(`${name}_count${k ? `{${k}}` : ''} ${h.count}`);
        }
      } else {
        for (const [k, v] of f.series) lines.push(k ? `${name}{${k}} ${v}` : `${name} ${v}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
