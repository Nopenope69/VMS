/**
 * Minimal Modbus TCP client (Phase 7) for networked relay and input modules: read coils (FC 1), read discrete
 * inputs (FC 2) and write a single coil (FC 5). One TCP connection per request keeps it simple and makes a
 * module that reboots or drops off the network show up as an error on the next call, never as stale state.
 *
 * Every response is checked: transaction id, protocol id, unit id, function code, byte count, and for FC 5 the
 * echoed address and value (the module's acknowledgement). A Modbus exception response is a ModbusError with
 * its code; a timeout or a closed connection is a ModbusError too. Tested against pymodbus (an independent
 * implementation) in modbusRelayRealIo.test.ts.
 */
import net from 'net';

export class ModbusError extends Error {
  constructor(public readonly code: 'TIMEOUT' | 'CONNECTION' | 'PROTOCOL' | 'EXCEPTION', message: string, public readonly exceptionCode?: number) {
    super(message);
    this.name = 'ModbusError';
  }
}

const EXCEPTIONS: Record<number, string> = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'server device failure',
  6: 'server device busy',
};

export interface ModbusTarget {
  host: string;
  port: number;
  unitId: number;
  timeoutMs?: number;
}

let nextTid = 1;

function exchange(t: ModbusTarget, pdu: Buffer): Promise<Buffer> {
  const tid = nextTid;
  nextTid = (nextTid % 0xffff) + 1;
  const adu = Buffer.alloc(7 + pdu.length);
  adu.writeUInt16BE(tid, 0);
  adu.writeUInt16BE(0, 2); // protocol id
  adu.writeUInt16BE(pdu.length + 1, 4);
  adu.writeUInt8(t.unitId, 6);
  pdu.copy(adu, 7);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: t.host, port: t.port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, v?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(v!);
    };
    const timer = setTimeout(() => finish(new ModbusError('TIMEOUT', `no Modbus reply from ${t.host}:${t.port} within ${t.timeoutMs ?? 2000} ms`)), t.timeoutMs ?? 2000);
    sock.on('connect', () => sock.write(adu));
    sock.on('error', (e) => finish(new ModbusError('CONNECTION', `Modbus connection to ${t.host}:${t.port} failed: ${e.message}`)));
    sock.on('close', () => finish(new ModbusError('CONNECTION', `Modbus connection to ${t.host}:${t.port} closed before a reply`)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 7) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len) return;
      if (buf.readUInt16BE(0) !== tid) return finish(new ModbusError('PROTOCOL', 'reply to another transaction'));
      if (buf.readUInt16BE(2) !== 0) return finish(new ModbusError('PROTOCOL', 'not a Modbus reply (protocol id)'));
      if (buf.readUInt8(6) !== t.unitId) return finish(new ModbusError('PROTOCOL', `reply from unit ${buf.readUInt8(6)}, asked unit ${t.unitId}`));
      const rpdu = buf.subarray(7, 6 + len);
      const fc = rpdu.readUInt8(0);
      // An exception reply sets the high bit of the function code. The spec echoes the request's function code
      // under it; pymodbus 3.8 sends 0x80 for a datastore failure, so any reply with the high bit is an exception.
      if (fc & 0x80) {
        const ex = rpdu.readUInt8(1);
        return finish(new ModbusError('EXCEPTION', `Modbus exception ${ex} (${EXCEPTIONS[ex] ?? 'unknown'})`, ex));
      }
      if (fc !== pdu.readUInt8(0)) return finish(new ModbusError('PROTOCOL', `reply function ${fc}, asked ${pdu.readUInt8(0)}`));
      finish(null, rpdu);
    });
  });
}

function readBits(t: ModbusTarget, fc: 1 | 2, address: number, count: number): Promise<boolean[]> {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff || !Number.isInteger(count) || count < 1 || count > 2000) {
    return Promise.reject(new ModbusError('PROTOCOL', 'address or count out of range'));
  }
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fc, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return exchange(t, pdu).then((r) => {
    const bytes = r.readUInt8(1);
    if (bytes !== Math.ceil(count / 8) || r.length !== 2 + bytes) throw new ModbusError('PROTOCOL', `byte count ${bytes} does not fit ${count} bits`);
    return Array.from({ length: count }, (_, i) => ((r.readUInt8(2 + (i >> 3)) >> (i & 7)) & 1) === 1);
  });
}

export const readCoils = (t: ModbusTarget, address: number, count = 1) => readBits(t, 1, address, count);
export const readDiscreteInputs = (t: ModbusTarget, address: number, count = 1) => readBits(t, 2, address, count);

/** FC 5. Resolves only when the module echoes the same address and value (its acknowledgement). */
export async function writeSingleCoil(t: ModbusTarget, address: number, on: boolean): Promise<void> {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new ModbusError('PROTOCOL', 'address out of range');
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(5, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(on ? 0xff00 : 0x0000, 3);
  const r = await exchange(t, pdu);
  if (r.length !== 5 || r.readUInt16BE(1) !== address || r.readUInt16BE(3) !== (on ? 0xff00 : 0)) throw new ModbusError('PROTOCOL', 'the module did not echo the coil write');
}
