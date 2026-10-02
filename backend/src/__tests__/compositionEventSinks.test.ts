/**
 * The composition root builds the one IncidentOrchestrator and hands its ingestEvent to every event producer; no
 * producer imports the orchestrator itself. A producer with no sink says so loudly instead of dropping the event.
 */
import { incidentOrchestrator, plateAggregator } from '../composition';
import streamWatchdogService, { StreamWatchdogService } from '../services/watchdog/streamWatchdog.service';
import sceneChangeDetector from '../services/motion/sceneChangeDetector.service';
import fs from 'fs';
import path from 'path';

describe('composition root event sinks', () => {
  afterAll(async () => {
    const prisma = (await import('../config/database')).default;
    await prisma.$disconnect();
  });

  it('routes the watchdog, scene detector and plate aggregator events into the one orchestrator', async () => {
    const spy = jest.spyOn(incidentOrchestrator, 'ingestEvent').mockResolvedValue({} as any);
    const ev = { id: 'e1' } as any;
    for (const producer of [streamWatchdogService, sceneChangeDetector, plateAggregator]) {
      const sink = (producer as any).eventSink;
      expect(typeof sink).toBe('function');
      await sink(ev);
    }
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('no service outside the composition root or its routes imports an orchestrator instance', () => {
    const root = path.join(__dirname, '..', 'services');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /\bincidentOrchestrator\b(?!\.service)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('a producer with no sink logs that the event was not routed', async () => {
    const prisma = {
      camera: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', name: 'Gate', tenantId: 't1', siteId: null, streamPath: 'gate', streamBaseline: null }), update: jest.fn() },
      streamDiagnostic: { create: jest.fn().mockResolvedValue({}) },
      alarm: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), update: jest.fn() },
    } as any;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await new StreamWatchdogService(prisma).evaluateStream('c1', { fps: 0, bitrateKbps: 0, resolution: 'UNKNOWN', videoCodec: 'none', ready: false });
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/no event sink wired/);
    warn.mockRestore();
    error.mockRestore();
  });
});
