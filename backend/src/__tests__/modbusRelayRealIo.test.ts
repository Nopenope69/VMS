/**
 * Phase 7 relays and doors against a SIMULATED networked I/O module: tools/sim/modbus_io_sim.py, a Modbus TCP
 * server built on pymodbus (an independent implementation of the protocol), plus the real database and API.
 * Nothing here has touched real relays, strikes or door contacts.
 *
 * Needs a Python with pymodbus (MODBUS_SIM_PYTHON, default python3). Skipped without it unless
 * VIGILONE_REQUIRE_MODBUS_SIM=1 (CI).
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { EventSeverity, PrismaClient } from '@prisma/client';
import { readCoils, readDiscreteInputs, writeSingleCoil, ModbusError } from '../services/hardware/modbusTcp';
import { RelayAdapter } from '../services/incident/orchestrator/adapters/relayAdapter';
import { DoorMonitor } from '../services/access/doorMonitor';
import { RuleEngine } from '../services/incident/orchestrator/ruleEngine';
import { createVigilOneEvent } from '../services/incident/orchestrator/events';
import { VigilOneEvent } from '../services/incident/orchestrator/types';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';

const py = process.env.MODBUS_SIM_PYTHON || 'python3';
const available = spawnSync(py, ['-c', 'import pymodbus'], { stdio: 'ignore' }).status === 0;
const required = process.env.VIGILONE_REQUIRE_MODBUS_SIM === '1';
jest.setTimeout(120000);

describe('Modbus simulator', () => {
  it('is available, or this run does not require it (VIGILONE_REQUIRE_MODBUS_SIM)', () => {
    if (!available && required) throw new Error(`${py} cannot import pymodbus; set MODBUS_SIM_PYTHON`);
    expect(available || !required).toBe(true);
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

(available ? describe : describe.skip)('relays and doors on a simulated Modbus TCP module', () => {
  const prisma = new PrismaClient();
  let sim: ChildProcess;
  let port = 0;
  let control = 0;
  let tenantId = '';
  let cameraId = '';
  let otherTenant = '';
  const target = () => ({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 2000 });

  const ctl = (cmd: string) =>
    new Promise<string>((resolve, reject) => {
      const s = net.connect(control, '127.0.0.1', () => s.write(cmd + '\n'));
      let out = '';
      s.on('data', (d) => (out += d.toString()));
      s.on('end', () => resolve(out.trim()));
      s.on('error', reject);
    });
  const world = async () => JSON.parse(await ctl('state')) as { coils: boolean[]; inputs: boolean[] };

  let deviceId = '';
  let pinSeq = 100;
  async function pin(direction: 'INPUT' | 'OUTPUT', address: number | null, extra: Record<string, unknown> = {}) {
    return prisma.digitalIoPin.create({
      data: { tenantId, pinNumber: pinSeq++, direction, name: `pin ${pinSeq}`, deviceId: address === null ? null : deviceId, address, timeoutMs: 1000, ...extra },
    });
  }

  beforeAll(async () => {
    port = await freePort();
    control = await freePort();
    sim = spawn(py, [path.join(__dirname, '../../../tools/sim/modbus_io_sim.py'), '--port', String(port), '--control-port', String(control)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the Modbus simulator did not start')), 20000);
      sim.stdout!.on('data', (d) => d.toString().includes('listening') && (clearTimeout(t), resolve()));
      sim.on('exit', (c) => reject(new Error(`the Modbus simulator exited (${c})`)));
    });
    // The control socket is up before the Modbus server; wait until Modbus answers.
    for (let i = 0; ; i++) {
      try {
        await readCoils(target(), 0, 1);
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'doors'));
    ({ tenantId: otherTenant } = await createTenantWithCamera(prisma, 'doors-other'));
    deviceId = (await prisma.ioDevice.create({ data: { tenantId, name: 'sim module', kind: 'MODBUS_TCP', host: '127.0.0.1', port, unitId: 1 } })).id;
  });

  afterAll(async () => {
    sim?.kill('SIGKILL');
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenant] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    for (const c of ['fail off', 'auto_open_on_unlock off', 'door_close', ...[0, 1, 2, 3].map((n) => `stick_coil ${n} off`)]) await ctl(c);
    for (const a of [0, 1, 2, 3]) await writeSingleCoil(target(), a, false);
  });

  describe('Modbus TCP client', () => {
    it('writes a coil only when the module echoes it, and reads coils and inputs back', async () => {
      await writeSingleCoil(target(), 2, true);
      expect(await readCoils(target(), 0, 4)).toEqual([false, false, true, false]);
      expect((await world()).coils.slice(0, 4)).toEqual([false, false, true, false]);
      await ctl('door_open');
      expect(await readDiscreteInputs(target(), 0, 2)).toEqual([true, false]);
    });

    it('reports a device failure as a Modbus exception, a closed port as a connection error and silence as a timeout', async () => {
      await ctl('fail on');
      await expect(writeSingleCoil(target(), 0, true)).rejects.toMatchObject({ code: 'EXCEPTION', exceptionCode: 4 });
      await expect(readDiscreteInputs(target(), 0, 1)).rejects.toBeInstanceOf(ModbusError);
      await ctl('fail off');
      await expect(readCoils({ ...target(), port: await freePort() }, 0, 1)).rejects.toMatchObject({ code: 'CONNECTION' });
      const silent = net.createServer(() => undefined).listen(0, '127.0.0.1');
      await new Promise((r) => silent.once('listening', r));
      await expect(readCoils({ ...target(), port: (silent.address() as net.AddressInfo).port, timeoutMs: 300 }, 0, 1)).rejects.toMatchObject({ code: 'TIMEOUT' });
      silent.close();
    });
  });

  describe('relay handshake', () => {
    it('SET_HIGH / SET_LOW: acknowledged by the module, then confirmed by reading the coil back', async () => {
      const p = await pin('OUTPUT', 1);
      const relay = new RelayAdapter(prisma);
      const on = await relay.execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(on.lifecycleState).toBe('STATE_CONFIRMED');
      expect((await world()).coils[1]).toBe(true);
      const log = await prisma.relayCommandLog.findUnique({ where: { id: on.logId } });
      expect(log!.acknowledgedAt).not.toBeNull();
      expect(log!.confirmedAt).not.toBeNull();
      expect((await prisma.digitalIoPin.findUnique({ where: { id: p.id } }))!.state).toBe('HIGH');
      const off = await relay.execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_LOW' });
      expect(off.lifecycleState).toBe('STATE_CONFIRMED');
      expect((await world()).coils[1]).toBe(false);
    });

    it('an active-low pin inverts the coil', async () => {
      const p = await pin('OUTPUT', 2, { activeLow: true });
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_LOW' });
      expect(r.lifecycleState).toBe('STATE_CONFIRMED');
      expect((await world()).coils[2]).toBe(true);
    });

    it('a stuck relay is acknowledged but never confirmed: COMMAND_FAILED, pin state unchanged', async () => {
      const p = await pin('OUTPUT', 1);
      await ctl('stick_coil 1 on');
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(r.lifecycleState).toBe('COMMAND_FAILED');
      expect(r.error).toMatch(/still reports the output off .*stuck relay/);
      const log = await prisma.relayCommandLog.findUnique({ where: { id: r.logId } });
      expect(log!.acknowledgedAt).not.toBeNull();
      expect(log!.confirmedAt).toBeNull();
      expect((await prisma.digitalIoPin.findUnique({ where: { id: p.id } }))!.state).toBe('LOW');
    });

    it('a failing module never acknowledges: COMMAND_FAILED without acknowledgedAt', async () => {
      const p = await pin('OUTPUT', 1);
      await ctl('fail on');
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(r.lifecycleState).toBe('COMMAND_FAILED');
      expect(r.error).toMatch(/exception 4/);
      expect((await prisma.relayCommandLog.findUnique({ where: { id: r.logId } }))!.acknowledgedAt).toBeNull();
    });

    it('ACK_ONLY stops at COMMAND_ACK: the output was not read back', async () => {
      const p = await pin('OUTPUT', 3, { confirmationMode: 'ACK_ONLY' });
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(r.lifecycleState).toBe('COMMAND_ACK');
      expect((await world()).coils[3]).toBe(true);
    });

    it('PULSE holds the output for the full duration, then confirms it off', async () => {
      const p = await pin('OUTPUT', 0);
      const t0 = Date.now();
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'PULSE', pulseDurationMs: 1200 });
      expect(r.lifecycleState).toBe('STATE_CONFIRMED');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
      expect((await world()).coils[0]).toBe(false);
    });

    it('PULSE whose relay sticks on says the relay may still be energised', async () => {
      const p = await pin('OUTPUT', 0);
      const sleep = async (ms: number) => {
        if (ms === 700) await ctl('stick_coil 0 on'); // the relay welds shut during the pulse
        await new Promise((r) => setTimeout(r, ms));
      };
      const r = await new RelayAdapter(prisma, sleep).execute({ tenantId, pinNumber: p.pinNumber, command: 'PULSE', pulseDurationMs: 700 });
      expect(r.lifecycleState).toBe('COMMAND_FAILED');
      expect(r.error).toMatch(/THE RELAY MAY STILL BE ENERGISED/);
      expect((await world()).coils[0]).toBe(true);
    });

    it('a pin without a module or driver fails with NO_PHYSICAL_RELAY_DRIVER_ATTACHED', async () => {
      const p = await pin('OUTPUT', null);
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(r.lifecycleState).toBe('COMMAND_FAILED');
      expect(r.error).toBe('NO_PHYSICAL_RELAY_DRIVER_ATTACHED');
    });

    it('a disabled module refuses the command', async () => {
      const dev = await prisma.ioDevice.create({ data: { tenantId, name: `disabled ${crypto.randomUUID()}`, kind: 'MODBUS_TCP', host: '127.0.0.1', port, unitId: 1, enabled: false } });
      const p = await prisma.digitalIoPin.create({ data: { tenantId, pinNumber: pinSeq++, direction: 'OUTPUT', name: 'disabled', deviceId: dev.id, address: 1 } });
      const r = await new RelayAdapter(prisma).execute({ tenantId, pinNumber: p.pinNumber, command: 'SET_HIGH' });
      expect(r.error).toMatch(/disabled/);
      expect((await world()).coils[1]).toBe(false);
    });
  });

  describe('door monitor', () => {
    let clock = Date.now();
    const events: VigilOneEvent[] = [];
    const monitor = new DoorMonitor(prisma, async (ev) => void events.push(ev), () => new Date(clock));
    const doorEvents = (doorId: string) => events.filter((e: any) => e.payload.doorId === doorId || e.payload.details?.doorId === doorId);

    async function door(extra: Record<string, unknown> = {}) {
      const contact = await pin('INPUT', 0);
      return prisma.door.create({ data: { tenantId, name: `door ${crypto.randomUUID()}`, cameraId, contactPinId: contact.id, heldOpenSeconds: 30, ...extra } });
    }
    beforeEach(async () => {
      // One door at a time reads input 0.
      await prisma.door.deleteMany({ where: { tenantId } });
      events.length = 0;
      clock = Date.now();
    });

    it('first poll records the state without an event; opening without an unlock is FORCED_OPEN, closing is CLOSED', async () => {
      const d = await door();
      await monitor.pollOnce();
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('CLOSED');
      expect(doorEvents(d.id)).toHaveLength(0);

      await ctl('door_open');
      clock += 1000;
      await monitor.pollOnce();
      clock += 4000;
      await monitor.pollOnce(); // still open, below the held-open limit: nothing
      await ctl('door_close');
      clock += 1000;
      await monitor.pollOnce();
      const evs = doorEvents(d.id);
      expect(evs.map((e: any) => [e.type, e.payload.action, e.severity])).toEqual([
        ['DOOR_EVENT', 'FORCED_OPEN', EventSeverity.CRITICAL],
        ['DOOR_EVENT', 'CLOSED', EventSeverity.INFO],
      ]);
      expect((evs[1].payload as any).openSeconds).toBe(5);
      expect(evs[0].cameraId).toBe(cameraId);
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('CLOSED');
    });

    it('opening within the unlock window is OPENED; after it, FORCED_OPEN', async () => {
      const d = await door({ unlockPulseMs: 5000, unlockGraceSeconds: 10 });
      await monitor.pollOnce();
      await prisma.door.update({ where: { id: d.id }, data: { lastUnlockAt: new Date(clock) } });
      await ctl('door_open');
      clock += 14_000;
      await monitor.pollOnce();
      await ctl('door_close');
      clock += 1000;
      await monitor.pollOnce();
      await ctl('door_open');
      clock += 1000; // now 16 s after the unlock: outside 5 s + 10 s
      await monitor.pollOnce();
      expect(doorEvents(d.id).map((e: any) => e.payload.action)).toEqual(['OPENED', 'CLOSED', 'FORCED_OPEN']);
    });

    it('a door open longer than heldOpenSeconds raises HELD_OPEN once', async () => {
      const d = await door();
      await monitor.pollOnce();
      await ctl('door_open');
      clock += 1000;
      await monitor.pollOnce();
      clock += 29_000;
      await monitor.pollOnce();
      clock += 1000;
      await monitor.pollOnce();
      clock += 60_000;
      await monitor.pollOnce();
      const evs = doorEvents(d.id);
      expect(evs.map((e: any) => e.payload.action)).toEqual(['FORCED_OPEN', 'HELD_OPEN']);
      expect(evs[1].severity).toBe(EventSeverity.CRITICAL);
      expect((evs[1].payload as any).openSeconds).toBe(30);
    });

    it('an inverted contact (contactOpenWhenOn = false) reads the other way', async () => {
      const d = await door({ contactOpenWhenOn: false });
      await monitor.pollOnce();
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('OPEN');
    });

    it('an unreadable module makes the door UNKNOWN with one alert; when it answers again no open event is invented', async () => {
      const d = await door();
      await monitor.pollOnce();
      await ctl('fail on');
      clock += 1000;
      await monitor.pollOnce();
      await monitor.pollOnce();
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('UNKNOWN');
      expect((await prisma.ioDevice.findUnique({ where: { id: deviceId } }))!.lastError).toMatch(/exception 4/);
      await ctl('door_open');
      await ctl('fail off');
      clock += 1000;
      await monitor.pollOnce();
      const evs = doorEvents(d.id);
      expect(evs.map((e: any) => [e.type, e.payload.alertCode])).toEqual([['SYSTEM_ALERT', 'DOOR_CONTACT_UNREADABLE']]);
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('OPEN');
      expect((await prisma.ioDevice.findUnique({ where: { id: deviceId } }))!.lastError).toBeNull();
    });

    it('two monitors polling at once report one change under one event id', async () => {
      const d = await door();
      await monitor.pollOnce();
      await ctl('door_open');
      clock += 1000;
      await Promise.all([monitor.pollOnce(), monitor.pollOnce()]);
      const ids = new Set(doorEvents(d.id).map((e) => e.id));
      expect(ids.size).toBe(1);
      expect((await prisma.door.findUnique({ where: { id: d.id } }))!.state).toBe('OPEN');
    });

    it('DOOR_EVENT rules match by door and action', async () => {
      const engine = new RuleEngine(prisma);
      const ev = (action: 'FORCED_OPEN' | 'OPENED', doorId = 'door-a') =>
        createVigilOneEvent({ tenantId, type: 'DOOR_EVENT', payload: { kind: 'DOOR_EVENT', doorId, doorName: 'A', action } });
      const rule = { triggerConfigJson: { doorIds: ['door-a'], doorActions: ['FORCED_OPEN', 'HELD_OPEN'] }, conditionsJson: [] };
      expect(await engine.matchesRule(rule, ev('FORCED_OPEN'))).toBe(true);
      expect(await engine.matchesRule(rule, ev('OPENED'))).toBe(false);
      expect(await engine.matchesRule(rule, ev('FORCED_OPEN', 'door-b'))).toBe(false);
      expect(await engine.matchesRule({ triggerConfigJson: {}, conditionsJson: [] }, ev('OPENED', 'door-b'))).toBe(true);
      expect(RuleEngine.candidateTriggerTypes('DOOR_EVENT')).toEqual(['DOOR_EVENT']);
    });
  });

  describe('access API', () => {
    let app: { url: string; close: () => Promise<void> };
    let admin = '';
    let operator = '';
    let viewer = '';
    let otherAdmin = '';
    const saved = process.env.VIGILONE_FEATURE_DIO_RELAY;
    const call = async (method: string, url: string, token: string, body?: unknown) => {
      const r = await fetch(`${app.url}/api/v1${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: r.status === 204 ? null : ((await r.json()) as any) };
    };

    beforeAll(async () => {
      process.env.VIGILONE_FEATURE_DIO_RELAY = 'true';
      app = await startApp();
      admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
      operator = (await createUserWithToken(prisma, tenantId, 'OPERATOR')).token;
      viewer = (await createUserWithToken(prisma, tenantId, 'VIEWER')).token;
      otherAdmin = (await createUserWithToken(prisma, otherTenant, 'TENANT_ADMIN')).token;
      await prisma.door.deleteMany({ where: { tenantId } });
    });
    afterAll(async () => {
      await app.close();
      if (saved === undefined) delete process.env.VIGILONE_FEATURE_DIO_RELAY;
      else process.env.VIGILONE_FEATURE_DIO_RELAY = saved;
    });

    it('configures a module, pins and a door; unlock pulses the strike, is audited, and the opening reads as OPENED', async () => {
      expect((await call('POST', '/access/io-devices', admin, { name: 'x', host: 'bad host!' })).status).toBe(400);
      expect((await call('POST', '/access/io-devices', admin, { name: 'x', host: '127.0.0.1', port: 70000 })).status).toBe(400);
      const dev = await call('POST', '/access/io-devices', admin, { name: 'api module', host: '127.0.0.1', port, unitId: 1 });
      expect(dev.status).toBe(201);
      expect((await call('POST', '/access/io-devices', admin, { name: 'api module', host: '127.0.0.1' })).status).toBe(409);
      // another tenant cannot bind a pin to this module, nor see it
      expect((await call('POST', '/relays/pins', otherAdmin, { pinNumber: 9, direction: 'OUTPUT', name: 'x', deviceId: dev.json.device.id, address: 0 })).status).toBe(400);
      expect((await call('GET', '/access/io-devices', otherAdmin)).json.devices).toEqual([]);
      expect((await call('POST', '/relays/pins', admin, { pinNumber: 1, direction: 'OUTPUT', name: 'strike', deviceId: dev.json.device.id })).status).toBe(400);
      expect((await call('POST', '/relays/pins', admin, { pinNumber: 1, direction: 'OUTPUT', name: 'strike', deviceId: dev.json.device.id, address: 0, timeoutMs: 1000 })).status).toBe(201);
      expect((await call('POST', '/relays/pins', admin, { pinNumber: 2, direction: 'INPUT', name: 'contact', deviceId: dev.json.device.id, address: 0 })).status).toBe(201);
      expect((await call('POST', '/access/doors', admin, { name: 'wrong', strikePinNumber: 2 })).json.error).toMatch(/needs an OUTPUT/);
      expect((await call('POST', '/access/doors', admin, { name: 'wrong', cameraId: crypto.randomUUID() })).json.error).toBe('camera not found');
      const d = await call('POST', '/access/doors', admin, { name: 'Front door', cameraId, strikePinNumber: 1, contactPinNumber: 2, unlockPulseMs: 1500 });
      expect(d.status).toBe(201);
      expect(d.json.door).toMatchObject({ state: 'UNKNOWN', strikePinNumber: 1, contactPinNumber: 2 });
      expect((await call('POST', '/access/doors', admin, { name: 'second', contactPinNumber: 2 })).json.error).toMatch(/already belongs to door "Front door"/);
      const id = d.json.door.id;

      expect((await call('POST', `/access/doors/${id}/unlock`, viewer)).status).toBe(403);
      expect((await call('POST', `/access/doors/${id}/unlock`, otherAdmin)).status).toBe(404);

      const events: VigilOneEvent[] = [];
      const monitor = new DoorMonitor(prisma, async (ev) => void events.push(ev));
      await monitor.pollOnce();
      await ctl('auto_open_on_unlock on'); // the simulated door swings open while the strike is energised
      const unlock = call('POST', `/access/doors/${id}/unlock`, operator);
      await new Promise((r) => setTimeout(r, 600));
      await monitor.pollOnce();
      const u = await unlock;
      expect(u.status).toBe(200);
      expect(u.json.result.lifecycleState).toBe('STATE_CONFIRMED');
      await monitor.pollOnce();
      expect(events.map((e: any) => e.payload.action)).toEqual(['OPENED', 'CLOSED']);
      const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'DOOR_UNLOCK', resourceId: id } });
      expect(audit!.metadataJson).toMatchObject({ lifecycleState: 'STATE_CONFIRMED', pulseMs: 1500 });
      const list = await call('GET', '/access/doors', viewer);
      expect(list.json.doors[0]).toMatchObject({ name: 'Front door', state: 'CLOSED', contactModule: { name: 'api module', lastError: null } });
    });

    it('an unlock the module never acknowledged is a 502, audited, and does not count as an unlock', async () => {
      const door = await prisma.door.findFirst({ where: { tenantId, name: 'Front door' } });
      await ctl('fail on');
      const u = await call('POST', `/access/doors/${door!.id}/unlock`, operator);
      expect(u.status).toBe(502);
      expect(u.json.error).toMatch(/exception 4/);
      expect((await prisma.door.findUnique({ where: { id: door!.id } }))!.lastUnlockAt?.getTime()).toBe(door!.lastUnlockAt?.getTime());
      const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'DOOR_UNLOCK', resourceId: door!.id }, orderBy: { sequenceNumber: 'desc' } });
      expect(audit!.metadataJson).toMatchObject({ lifecycleState: 'COMMAND_FAILED' });
    });

    it('a door without a strike cannot be unlocked', async () => {
      const d = await call('POST', '/access/doors', admin, { name: 'Contact only' });
      expect((await call('POST', `/access/doors/${d.json.door.id}/unlock`, operator)).status).toBe(409);
    });
  });
});
