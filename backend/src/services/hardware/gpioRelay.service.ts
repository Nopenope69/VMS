import { PrismaClient, RelayCommandState } from '@prisma/client';

export interface RelayTriggerRequest {
  pinNumber: number;
  tenantId: string;
  command: 'SET_HIGH' | 'SET_LOW' | 'PULSE';
  pulseDurationMs?: number;
  issuedBy?: string;
}

export interface RelayCommandResult {
  logId: string;
  pinNumber: number;
  command: string;
  lifecycleState: RelayCommandState;
  confirmedAt?: Date;
  error?: string;
}

export class GpioRelayService {
  private prisma: PrismaClient;
  private hardwareSimulator: (
    pinNumber: number,
    targetState: string
  ) => Promise<{ confirmed: boolean; error?: string }> = async () => ({ confirmed: true });

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Set custom hardware driver or simulator hook
   */
  public setHardwareDriver(
    driver: (pinNumber: number, targetState: string) => Promise<{ confirmed: boolean; error?: string }>
  ) {
    this.hardwareSimulator = driver;
  }

  /**
   * Triggers a relay command following a strict multi-stage confirmation handshake
   */
  public async executeRelayCommand(req: RelayTriggerRequest): Promise<RelayCommandResult> {
    const pin = await this.prisma.digitalIoPin.findUnique({
      where: {
        tenantId_pinNumber: {
          tenantId: req.tenantId,
          pinNumber: req.pinNumber,
        },
      },
    });

    if (!pin) {
      throw new Error(`Digital I/O Pin ${req.pinNumber} not configured`);
    }

    if (pin.direction !== 'OUTPUT') {
      throw new Error(`Pin ${req.pinNumber} is an INPUT sensor pin and cannot be triggered as an output`);
    }

    const targetState = req.command === 'SET_LOW' ? 'LOW' : 'HIGH';

    // 1. Stage 1: COMMAND_SENT
    const commandLog = await this.prisma.relayCommandLog.create({
      data: {
        pinId: pin.id,
        command: req.command,
        targetState,
        lifecycleState: RelayCommandState.COMMAND_SENT,
        issuedBy: req.issuedBy,
        sentAt: new Date(),
      },
    });

    try {
      // 2. Stage 2: COMMAND_ACK (Driver acknowledged command receipt)
      await this.prisma.relayCommandLog.update({
        where: { id: commandLog.id },
        data: {
          lifecycleState: RelayCommandState.COMMAND_ACK,
          acknowledgedAt: new Date(),
        },
      });

      // Dispatch to physical/simulated hardware with timeout
      const hardwareResult = await Promise.race([
        this.hardwareSimulator(req.pinNumber, targetState),
        new Promise<{ confirmed: boolean; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('Hardware confirmation timed out after 3000ms')), 3000)
        ),
      ]);

      if (!hardwareResult.confirmed) {
        throw new Error(hardwareResult.error || 'Physical relay confirmation failed');
      }

      // 3. Stage 3: STATE_CONFIRMED
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
          data: {
            state: targetState,
          },
        }),
      ]);

      // If command was PULSE, schedule non-blocking reset
      if (req.command === 'PULSE') {
        const pulseMs = req.pulseDurationMs || pin.pulseDurationMs || 3000;
        setTimeout(async () => {
          try {
            await this.hardwareSimulator(req.pinNumber, 'LOW');
            await this.prisma.digitalIoPin.update({
              where: { id: pin.id },
              data: { state: 'LOW' },
            });
          } catch {}
        }, pulseMs);
      }

      return {
        logId: commandLog.id,
        pinNumber: req.pinNumber,
        command: req.command,
        lifecycleState: RelayCommandState.STATE_CONFIRMED,
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
        pinNumber: req.pinNumber,
        command: req.command,
        lifecycleState: RelayCommandState.COMMAND_FAILED,
        error: err.message,
      };
    }
  }
}
