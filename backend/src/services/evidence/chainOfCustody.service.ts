import { ChainOfCustodyLog, PrismaClient } from '@prisma/client';
import {
  CustodyLedger,
  LogCustodyEventInput,
  CustodyVerificationResult,
} from './archive/custodyLedger';

export { LogCustodyEventInput, CustodyVerificationResult };

/**
 * Backward compatibility facade delegating to CustodyLedger within EvidenceArchive deep module.
 * @deprecated Use CustodyLedger or EvidenceArchive directly.
 */
export class ChainOfCustodyService {
  public ledger: CustodyLedger;

  constructor(prisma: PrismaClient) {
    this.ledger = new CustodyLedger(prisma);
  }

  public async recordEvent(input: LogCustodyEventInput): Promise<ChainOfCustodyLog> {
    return this.ledger.recordEvent(input);
  }

  public async logEvent(input: LogCustodyEventInput): Promise<ChainOfCustodyLog> {
    return this.ledger.recordEvent(input);
  }

  public async getCustodyHistory(
    tenantId: string,
    evidenceId: string
  ): Promise<ChainOfCustodyLog[]> {
    return this.ledger.getHistory(tenantId, evidenceId);
  }

  public async verifyCustodyChain(
    tenantId: string,
    evidenceId: string
  ): Promise<CustodyVerificationResult> {
    return this.ledger.verifyChain(tenantId, evidenceId);
  }
}

export default ChainOfCustodyService;
