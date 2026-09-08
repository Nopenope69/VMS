import { PrismaClient, RelayCommandState } from '@prisma/client';
import { RelayAdapter } from '../incident/orchestrator/adapters/relayAdapter';

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

/**
 * @deprecated Use IncidentOrchestrator or RelayAdapter directly.
 * Compatibility shim delegating to authoritative IncidentOrchestrator RelayAdapter.
 */
export class GpioRelayService {
  private prisma: PrismaClient;
  private adapter: RelayAdapter;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.adapter = new RelayAdapter(prisma);
  }

  /**
   * Set custom hardware driver or simulator hook
   */
  public setHardwareDriver(
    driver: (pinNumber: number, targetState: string) => Promise<{ confirmed: boolean; error?: string }>
  ) {
    this.adapter.setHardwareDriver(driver);
  }

  /**
   * Triggers a relay command following a strict multi-stage confirmation handshake
   */
  public async executeRelayCommand(req: RelayTriggerRequest): Promise<RelayCommandResult> {
    const res = await this.adapter.execute({
      pinNumber: req.pinNumber,
      tenantId: req.tenantId,
      command: req.command,
      pulseDurationMs: req.pulseDurationMs,
      issuedBy: req.issuedBy,
    });

    return {
      logId: res.logId,
      pinNumber: res.pinNumber,
      command: res.command,
      lifecycleState: res.lifecycleState,
      confirmedAt: res.confirmedAt,
      error: res.error,
    };
  }
}
