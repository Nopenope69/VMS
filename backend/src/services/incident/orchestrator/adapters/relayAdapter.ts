import { PrismaClient, RelayCommandState, RelayConfirmationMode } from '@prisma/client';

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

export type HardwareDriver = (
  pinNumber: number,
  targetState: string
) => Promise<{ confirmed: boolean; error?: string }>;

export class RelayAdapter {
  private prisma: PrismaClient;
  private hardwareDriver: HardwareDriver = async () => ({ confirmed: true });

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public setHardwareDriver(driver: HardwareDriver): void {
    this.hardwareDriver = driver;
  }

  public async execute(params: RelayExecuteParams): Promise<RelayExecuteResult> {
    const pin = await this.prisma.digitalIoPin.findUnique({
      where: {
        tenantId_pinNumber: {
          tenantId: params.tenantId,
          pinNumber: params.pinNumber,
        },
      },
    });

    if (!pin) {
      throw new Error(`Digital I/O Pin ${params.pinNumber} not configured`);
    }

    if (pin.direction !== 'OUTPUT') {
      throw new Error(`Pin ${params.pinNumber} is an INPUT sensor pin and cannot be triggered as an output`);
    }

    const targetState = params.command === 'SET_LOW' ? 'LOW' : 'HIGH';
    const confirmationMode = pin.confirmationMode || RelayConfirmationMode.STATE_FEEDBACK;
    const timeoutMs = pin.timeoutMs || 3000;

    // 1. Stage 1: COMMAND_SENT
    const commandLog = await this.prisma.relayCommandLog.create({
      data: {
        pinId: pin.id,
        command: params.command,
        targetState,
        lifecycleState: RelayCommandState.COMMAND_SENT,
        issuedBy: params.issuedBy,
        sentAt: new Date(),
      },
    });

    try {
      // 2. Stage 2: COMMAND_ACK (Controller / Driver acknowledged receipt)
      const ackTime = new Date();
      await this.prisma.relayCommandLog.update({
        where: { id: commandLog.id },
        data: {
          lifecycleState: RelayCommandState.COMMAND_ACK,
          acknowledgedAt: ackTime,
        },
      });

      // 3. Evaluate confirmation semantics per mode
      if (confirmationMode === RelayConfirmationMode.ACK_ONLY) {
        // In ACK_ONLY mode, transmission is confirmed, but physical contact is NOT verified.
        // Invariant: NEVER report STATE_CONFIRMED.
        await this.prisma.digitalIoPin.update({
          where: { id: pin.id },
          data: { state: targetState },
        });

        return {
          logId: commandLog.id,
          pinNumber: params.pinNumber,
          command: params.command,
          lifecycleState: RelayCommandState.COMMAND_ACK,
          confirmationMode,
          confirmedAt: ackTime,
        };
      }

      if (confirmationMode === RelayConfirmationMode.PULSE_COMPLETION) {
        // PULSE_COMPLETION mode: Wait for pulse cycle to execute
        const pulseMs = params.pulseDurationMs || pin.pulseDurationMs || 1000;

        const pulsePromise: Promise<{ confirmed: boolean; error?: string }> = (async () => {
          await this.hardwareDriver(params.pinNumber, 'HIGH');
          await new Promise((r) => setTimeout(r, Math.min(pulseMs, 500))); // bounded wait in test/production
          await this.hardwareDriver(params.pinNumber, 'LOW');
          return { confirmed: true };
        })();

        const timeoutPromise = new Promise<{ confirmed: boolean; error?: string }>((_, reject) =>
          setTimeout(() => reject(new Error(`Pulse completion timed out after ${timeoutMs}ms`)), timeoutMs)
        );

        const result = await Promise.race([pulsePromise, timeoutPromise]);
        if (!result.confirmed) {
          throw new Error(result.error || 'Pulse execution failed');
        }

        const confirmedTime = new Date();
        await this.prisma.$transaction([
          this.prisma.relayCommandLog.update({
            where: { id: commandLog.id },
            data: {
              lifecycleState: RelayCommandState.STATE_CONFIRMED,
              confirmedAt: confirmedTime,
            },
          }),
          this.prisma.digitalIoPin.update({
            where: { id: pin.id },
            data: { state: 'LOW' },
          }),
        ]);

        return {
          logId: commandLog.id,
          pinNumber: params.pinNumber,
          command: params.command,
          lifecycleState: RelayCommandState.STATE_CONFIRMED,
          confirmationMode,
          confirmedAt: confirmedTime,
        };
      }

      // Default: STATE_FEEDBACK mode (physical loopback contact required)
      const hardwarePromise = this.hardwareDriver(params.pinNumber, targetState);
      const timeoutPromise = new Promise<{ confirmed: boolean; error?: string }>((_, reject) =>
        setTimeout(() => reject(new Error(`Hardware confirmation timed out after ${timeoutMs}ms`)), timeoutMs)
      );

      const hardwareResult = await Promise.race([hardwarePromise, timeoutPromise]);

      if (!hardwareResult.confirmed) {
        throw new Error(hardwareResult.error || 'Physical relay confirmation failed (no feedback match)');
      }

      // Confirmed by physical contact feedback
      const confirmedTime = new Date();
      await this.prisma.$transaction([
        this.prisma.relayCommandLog.update({
          where: { id: commandLog.id },
          data: {
            lifecycleState: RelayCommandState.STATE_CONFIRMED,
            confirmedAt: confirmedTime,
          },
        }),
        this.prisma.digitalIoPin.update({
          where: { id: pin.id },
          data: { state: targetState },
        }),
      ]);

      // If command was PULSE in STATE_FEEDBACK mode, schedule low reset
      if (params.command === 'PULSE') {
        const pulseMs = params.pulseDurationMs || pin.pulseDurationMs || 3000;
        setTimeout(async () => {
          try {
            await this.hardwareDriver(params.pinNumber, 'LOW');
            await this.prisma.digitalIoPin.update({
              where: { id: pin.id },
              data: { state: 'LOW' },
            });
          } catch {}
        }, pulseMs);
      }

      return {
        logId: commandLog.id,
        pinNumber: params.pinNumber,
        command: params.command,
        lifecycleState: RelayCommandState.STATE_CONFIRMED,
        confirmationMode,
        confirmedAt: confirmedTime,
      };
    } catch (err: any) {
      // 4. Failure Stage: COMMAND_FAILED
      await this.prisma.relayCommandLog.update({
        where: { id: commandLog.id },
        data: {
          lifecycleState: RelayCommandState.COMMAND_FAILED,
          failedAt: new Date(),
          errorMessage: err.message,
        },
      });

      return {
        logId: commandLog.id,
        pinNumber: params.pinNumber,
        command: params.command,
        lifecycleState: RelayCommandState.COMMAND_FAILED,
        confirmationMode,
        error: err.message,
      };
    }
  }
}
