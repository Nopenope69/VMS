/**
 * Input rules of the headquarters sync engine (Phase 6), without a database. The chain, storage and link-loss
 * behaviour are tested on the real database in federationSyncRealDb.test.ts.
 *
 * This file replaced tests of the earlier EVENT/AUDIT/ALARM streams: EVENT wrote site events into
 * headquarters' own DetectionEvent table under a camera id the site chose, and AUDIT and ALARM advanced the
 * cursor while storing nothing. Those streams are now refused.
 */
import { SyncEngineService, SyncError, MAX_BATCH_RECORDS } from '../services/federation/syncEngine.service';

describe('SyncEngineService input rules', () => {
  const nodeUuid = 'node_sync_edge_001';
  let service: SyncEngineService;
  let transaction: jest.Mock;

  beforeEach(() => {
    transaction = jest.fn();
    const mockPrisma: any = {
      federatedNode: { findUnique: jest.fn().mockResolvedValue({ syncCursorLog: 7n, lastLogHash: 'a'.repeat(64) }) },
      $transaction: transaction,
    };
    service = new SyncEngineService(mockPrisma);
  });

  it('reports the LOG cursor and hash', async () => {
    expect(await service.getSyncCursor(nodeUuid)).toEqual({ seq: 7n, hash: 'a'.repeat(64) });
  });

  it.each(['EVENT', 'AUDIT', 'ALARM', undefined])('refuses the retired stream %s before touching the database', async (streamType) => {
    await expect(service.processSyncBatch(nodeUuid, { streamType, afterSeq: '0', afterHash: '0'.repeat(64), records: [] } as any)).rejects.toMatchObject({ code: 'STREAM_RETIRED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['no records', { records: [] }],
    ['too many records', { records: new Array(MAX_BATCH_RECORDS + 1).fill({}) }],
    ['a non-decimal afterSeq', { afterSeq: '-1' }],
    ['a malformed afterHash', { afterHash: 'xyz' }],
  ])('refuses a batch with %s', async (_n, over) => {
    const body = { streamType: 'LOG', afterSeq: '0', afterHash: '0'.repeat(64), records: [{}], ...over };
    const e = await service.processSyncBatch(nodeUuid, body as any).catch((x) => x);
    expect(e).toBeInstanceOf(SyncError);
    expect(e.code).toBe('BATCH_INVALID');
    expect(transaction).not.toHaveBeenCalled();
  });
});
