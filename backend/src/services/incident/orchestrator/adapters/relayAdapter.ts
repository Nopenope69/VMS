/**
 * Relay commands with an honest confirmation handshake (Phase 7).
 *
 *   COMMAND_SENT     the command was logged before anything was sent;
 *   COMMAND_ACK      the device acknowledged it (a Modbus module echoes the coil write);
 *   STATE_CONFIRMED  the device then reported the output in the commanded state (coil read back), or, for a
 *                    pulse, reported it on and then off again after the full pulse;
 *   COMMAND_FAILED   anything else, with the reason.
 *
 * A pin is driven by its I/O module (IoDevice, Modbus TCP) when it has one. Otherwise an injected driver is used
 * (simulators and tests); with neither, every command fails with NO_PHYSICAL_RELAY_DRIVER_ATTACHED. Nothing is
 * marked acknowledged before a device answered, and the pin's stored state changes only on an acknowledgement
 * (ACK_ONLY) or a confirmation.
 *
 * ACK_ONLY never reports STATE_CONFIRMED: the module echoed the command, but its output was not read back. A
 * read-back reports the module's output register, not the physical contact; a door contact (Door) is what shows
 * whether a door actually opened.
 */
import { PrismaClient, RelayCommandState, RelayConfirmationMode } from '@prisma/client';
import { readCoils, writeSingleCoil, ModbusTarget } from '../../../hardware/modbusTcp';

export interface RelayExecuteParams {
  tenantId: string;
  pinNumber: number;
  command: 'SET_HIGH' | 'SET_LOW' | 'PULSE';
  pulseDurationMs?: number;
  issuedBy?: string;
}

export interface RelayExecuteResult {
  logId: string;
  pinNumber: number;
  command: string;
  lifecycleState: RelayCommandState;
  confirmationMode: RelayConfirmationMode;
  confirmedAt?: Date;
  error?: string;
}

/** Injected driver (simulators, tests): sets the pin and says whether the hardware confirmed it. */
export type HardwareDriver = (pinNumber: number, targetState: string) => Promise<{ confirmed: boolean; error?: string }>;

/** A driver for one output pin: write resolves when the device acknowledged, read returns the output state. */
interface PinDriver {
  write(on: boolean): Promise<void>;
  read(): Promise<boolean> | null;
}

export const MAX_PULSE_MS = 30_000;
const POLL_MS = 100;

export class RelayAdapter {
  private injected: HardwareDriver | null = null;

  constructor(private readonly prisma: PrismaClient, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** Simulators and tests only: drive pins that have no I/O module. */
  public setHardwareDriver(driver: HardwareDriver): void {
    this.injected = driver;
  }

  private driverFor(pin: { pinNumber: number; activeLow: boolean; address: number | null; device: { kind: string; host: string; port: number; unitId: number; enabled: boolean } | null }): PinDriver {
    if (pin.device) {
      if (!pin.device.enabled) throw new Error('the I/O module of this pin is disabled');
      if (pin.device.kind !== 'MODBUS_TCP') throw new Error(`unsupported I/O module kind ${pin.device.kind}`);
      if (pin.address === null) throw new Error('the pin has an I/O module but no address');
      const t: ModbusTarget = { host: pin.device.host, port: pin.device.port, unitId: pin.device.unitId, timeoutMs: 2000 };
      const addr = pin.address;
      const coil = (on: boolean) => (pin.activeLow ? !on : on);
      return {
        write: (on) => writeSingleCoil(t, addr, coil(on)),
        read: () => readCoils(t, addr, 1).then(([v]) => coil(v)),
      };
    }
    const injected = this.injected;
    if (!injected) throw new Error('NO_PHYSICAL_RELAY_DRIVER_ATTACHED');
    // An injected driver acknowledges and confirms in one call; it has no separate read-back.
    return {
      write: async (on) => {
        const r = await injected(pin.pinNumber, on ? 'HIGH' : 'LOW');
        if (!r.confirmed) throw new Error(r.error || 'the relay driver did not confirm');
      },
      read: () => null,
    };
  }

  /** Waits until the read-back shows `on`, or throws when the pin's timeout passes. */
  private async confirm(d: PinDriver, on: boolean, timeoutMs: number): Promise<void> {
    const first = d.read();
    if (first === null) return; // injected driver: its write already confirmed
    const until = Date.now() + timeoutMs;
    let seen = await first;
    while (seen !== on) {
      if (Date.now() >= until) throw new Error(`the module still reports the output ${seen ? 'on' : 'off'} ${timeoutMs} ms after it acknowledged turning it ${on ? 'on' : 'off'} (stuck relay?)`);
      await this.sleep(POLL_MS);
      seen = await d.read()!;
    }
  }

  public async execute(params: RelayExecuteParams): Promise<RelayExecuteResult> {
    const pin = await this.prisma.digitalIoPin.findUnique({
      where: { tenantId_pinNumber: { tenantId: params.tenantId, pinNumber: params.pinNumber } },
      include: { device: true },
    });
    if (!pin) throw new Error(`Digital I/O Pin ${params.pinNumber} not configured`);
    if (pin.direction !== 'OUTPUT') throw new Error(`Pin ${params.pinNumber} is an INPUT sensor pin and cannot be triggered as an output`);
    if (pin.device && pin.device.tenantId !== params.tenantId) throw new Error('the pin is bound to another tenant’s I/O module');

    const mode = pin.confirmationMode || RelayConfirmationMode.STATE_FEEDBACK;
    const timeoutMs = pin.timeoutMs || 3000;
    const targetState = params.command === 'SET_LOW' ? 'LOW' : 'HIGH';
    const log = await this.prisma.relayCommandLog.create({
      data: { pinId: pin.id, command: params.command, targetState, lifecycleState: RelayCommandState.COMMAND_SENT, issuedBy: params.issuedBy, sentAt: new Date() },
    });
    const base = { logId: log.id, pinNumber: params.pinNumber, command: params.command, confirmationMode: mode };
    let energised = false;
    try {
      const d = this.driverFor(pin);
      const on = params.command !== 'SET_LOW';
      await d.write(on);
      energised = on;
      const ackAt = new Date();
      await this.prisma.relayCommandLog.update({ where: { id: log.id }, data: { lifecycleState: RelayCommandState.COMMAND_ACK, acknowledgedAt: ackAt } });

      if (params.command === 'PULSE') {
        if (mode !== RelayConfirmationMode.ACK_ONLY) await this.confirm(d, true, timeoutMs);
        const pulseMs = Math.min(params.pulseDurationMs || pin.pulseDurationMs || 1000, MAX_PULSE_MS);
        await this.sleep(pulseMs);
        await d.write(false);
        if (mode === RelayConfirmationMode.ACK_ONLY) {
          await this.prisma.digitalIoPin.update({ where: { id: pin.id }, data: { state: 'LOW' } });
          return { ...base, lifecycleState: RelayCommandState.COMMAND_ACK, confirmedAt: ackAt };
        }
        // Still counted as energised until the read-back shows it off.
        await this.confirm(d, false, timeoutMs);
        energised = false;
      } else if (mode === RelayConfirmationMode.ACK_ONLY) {
        await this.prisma.digitalIoPin.update({ where: { id: pin.id }, data: { state: targetState } });
        return { ...base, lifecycleState: RelayCommandState.COMMAND_ACK, confirmedAt: ackAt };
      } else {
        await this.confirm(d, on, timeoutMs);
      }
      const confirmedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.relayCommandLog.update({ where: { id: log.id }, data: { lifecycleState: RelayCommandState.STATE_CONFIRMED, confirmedAt } }),
        this.prisma.digitalIoPin.update({ where: { id: pin.id }, data: { state: params.command === 'PULSE' ? 'LOW' : targetState } }),
      ]);
      return { ...base, lifecycleState: RelayCommandState.STATE_CONFIRMED, confirmedAt };
    } catch (err: any) {
      const message = params.command === 'PULSE' && energised ? `${err.message}; THE RELAY MAY STILL BE ENERGISED (turning it off failed or was not confirmed)` : err.message;
      await this.prisma.relayCommandLog.update({ where: { id: log.id }, data: { lifecycleState: RelayCommandState.COMMAND_FAILED, failedAt: new Date(), errorMessage: String(message).slice(0, 1000) } });
      return { ...base, lifecycleState: RelayCommandState.COMMAND_FAILED, error: message };
    }
  }
}
