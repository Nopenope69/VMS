/**
 * Door monitor (Phase 7): polls the door contact of every door whose contact pin lives on an enabled I/O module
 * (Modbus TCP discrete input) and turns contact changes into DOOR_EVENT events for the incident orchestrator:
 *
 *   OPENED       the door opened within unlockPulseMs + unlockGraceSeconds of an unlock through VigilOne (INFO);
 *   FORCED_OPEN  the door opened without such an unlock (CRITICAL);
 *   HELD_OPEN    the door has stayed open longer than heldOpenSeconds (CRITICAL, once per opening);
 *   CLOSED       the door closed again (INFO, with how long it was open).
 *
 * The door's state is only what the contact reported. When the module cannot be read the door becomes UNKNOWN
 * and one SYSTEM_ALERT (DOOR_CONTACT_UNREADABLE) is raised; nothing is guessed. Leaving UNKNOWN (first poll after
 * start, or the module back) records the state without an OPENED / FORCED_OPEN event: how the door got into that
 * state was not observed. A door forced open while its module was unreachable is therefore NOT reported as
 * forced; the UNKNOWN alert is what tells the operator to look.
 *
 * Unlocks made outside VigilOne (a card reader wired straight to the strike) are not known here, so such an
 * opening reads as FORCED_OPEN. Doors with card readers need an access-control integration, which is not built.
 *
 * Event ids are derived from the door and the time its current state began, so re-running a poll after a crash
 * between the event and the state update does not produce a second event (the orchestrator drops duplicates);
 * state updates are conditional on the state that was read, so two monitors cannot both report a change.
 */
import { EventSeverity, PrismaClient } from '@prisma/client';
import { readDiscreteInputs } from '../hardware/modbusTcp';
import { createVigilOneEvent, fromSystemAlert } from '../incident/orchestrator/events';
import { DoorEventPayload, VigilOneEvent } from '../incident/orchestrator/types';

export type Ingest = (event: VigilOneEvent) => Promise<unknown>;

export interface DoorPollResult {
  doors: number;
  events: { doorId: string; action: DoorEventPayload['action'] | 'UNREADABLE' }[];
  errors: { doorId: string; error: string }[];
}

const SEVERITY: Record<DoorEventPayload['action'], EventSeverity> = {
  OPENED: EventSeverity.INFO,
  CLOSED: EventSeverity.INFO,
  FORCED_OPEN: EventSeverity.CRITICAL,
  HELD_OPEN: EventSeverity.CRITICAL,
};

const TITLE: Record<DoorEventPayload['action'], string> = {
  OPENED: 'opened after an unlock',
  CLOSED: 'closed',
  FORCED_OPEN: 'FORCED OPEN (no unlock)',
  HELD_OPEN: 'held open',
};

export class DoorMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingest: Ingest,
    private readonly now: () => Date = () => new Date()
  ) {}

  public start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.pollOnce()
        .catch((err) => console.error('[DoorMonitor] poll failed:', err.message))
        .finally(() => (this.running = false));
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async pollOnce(): Promise<DoorPollResult> {
    const doors = await this.prisma.door.findMany({
      where: { contactPin: { is: { direction: 'INPUT', address: { not: null }, device: { is: { enabled: true } } } } },
      include: { contactPin: { include: { device: true } } },
    });
    const result: DoorPollResult = { doors: doors.length, events: [], errors: [] };
    for (const door of doors) {
      const pin = door.contactPin!;
      const dev = pin.device!;
      const at = this.now();
      let bit: boolean;
      try {
        [bit] = await readDiscreteInputs({ host: dev.host, port: dev.port, unitId: dev.unitId, timeoutMs: 2000 }, pin.address!, 1);
      } catch (err: any) {
        const error = String(err.message).slice(0, 500);
        result.errors.push({ doorId: door.id, error });
        await this.prisma.ioDevice.update({ where: { id: dev.id }, data: { lastError: error } });
        if (door.state !== 'UNKNOWN') {
          await this.ingest(
            fromSystemAlert({
              id: `door_${door.id}_unreadable_${(door.stateChangedAt ?? door.createdAt).getTime()}`,
              tenantId: door.tenantId,
              cameraId: door.cameraId ?? undefined,
              source: 'HARDWARE_IO',
              severity: EventSeverity.WARNING,
              subsystem: 'DOOR_MONITOR',
              alertCode: 'DOOR_CONTACT_UNREADABLE',
              message: `The contact of door "${door.name}" cannot be read (${error}); its state is UNKNOWN until the I/O module answers again.`,
              details: { doorId: door.id, ioDeviceId: dev.id },
            })
          );
          await this.prisma.door.updateMany({ where: { id: door.id, state: door.state }, data: { state: 'UNKNOWN', stateChangedAt: at, heldOpenAlertedAt: null } });
          result.events.push({ doorId: door.id, action: 'UNREADABLE' });
        }
        continue;
      }
      await this.prisma.ioDevice.update({ where: { id: dev.id }, data: { lastSeenAt: at, lastError: null } });

      const open = door.contactOpenWhenOn ? bit : !bit;
      const since = door.stateChangedAt ?? door.createdAt;
      let action: DoorEventPayload['action'] | null = null;
      let data: Record<string, unknown> | null = null;
      let openSeconds: number | undefined;

      if (door.state === 'UNKNOWN') {
        data = { state: open ? 'OPEN' : 'CLOSED', stateChangedAt: at, heldOpenAlertedAt: null };
      } else if (door.state === 'CLOSED' && open) {
        const authorisedUntil = door.lastUnlockAt ? door.lastUnlockAt.getTime() + door.unlockPulseMs + door.unlockGraceSeconds * 1000 : -Infinity;
        action = at.getTime() <= authorisedUntil ? 'OPENED' : 'FORCED_OPEN';
        data = { state: 'OPEN', stateChangedAt: at, heldOpenAlertedAt: null };
      } else if (door.state === 'OPEN' && !open) {
        action = 'CLOSED';
        openSeconds = Math.round((at.getTime() - since.getTime()) / 1000);
        data = { state: 'CLOSED', stateChangedAt: at, heldOpenAlertedAt: null };
      } else if (door.state === 'OPEN' && open && !door.heldOpenAlertedAt && at.getTime() - since.getTime() >= door.heldOpenSeconds * 1000) {
        action = 'HELD_OPEN';
        openSeconds = Math.round((at.getTime() - since.getTime()) / 1000);
        data = { heldOpenAlertedAt: at };
      }
      if (!data) continue;

      if (action) {
        await this.ingest(
          createVigilOneEvent<DoorEventPayload>({
            id: `door_${door.id}_${action}_${since.getTime()}`,
            tenantId: door.tenantId,
            cameraId: door.cameraId ?? undefined,
            source: 'HARDWARE_IO',
            type: 'DOOR_EVENT',
            severity: SEVERITY[action],
            title: `Door "${door.name}" ${TITLE[action]}${openSeconds !== undefined ? ` (${openSeconds} s)` : ''}`,
            payload: { kind: 'DOOR_EVENT', doorId: door.id, doorName: door.name, action, openSeconds },
          })
        );
        result.events.push({ doorId: door.id, action });
      }
      await this.prisma.door.updateMany({ where: { id: door.id, state: door.state, stateChangedAt: door.stateChangedAt }, data });
    }
    return result;
  }
}
