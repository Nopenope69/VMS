import { PrismaClient } from '@prisma/client';
import { EvidenceArchive, CreateEvidenceParams } from './evidence/archive';

export { CreateEvidenceParams };

/**
 * Backward compatibility facade delegating to authoritative EvidenceArchive deep module.
 * @deprecated Use EvidenceArchive from services/evidence/archive directly.
 */
export class EvidenceExportService {
  private archive: EvidenceArchive;

  constructor(prisma: PrismaClient) {
    this.archive = new EvidenceArchive(prisma);
  }

  async processExport(params: CreateEvidenceParams): Promise<string> {
    return this.archive.processExport(params);
  }
}

export default EvidenceExportService;
