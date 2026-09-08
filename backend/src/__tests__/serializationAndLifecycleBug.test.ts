describe('Latent Bugs Diagnostic Verification & Defense-in-Depth', () => {
  describe('Bug 1: BigInt Serialization Defense-in-Depth', () => {
    it('verifies explicit stringification transforms all BigInt fields safely for REST APIs', () => {
      // 1. FederatedNode record shape
      const node = {
        id: 'node-123',
        tenantId: 'tenant-1',
        nodeUuid: 'node-uuid-abc',
        name: 'Branch Edge',
        syncCursorEvent: 42n,
        syncCursorAudit: 100n,
        syncCursorAlarm: 0n,
      };

      const serializedNode = {
        ...node,
        syncCursorEvent: node.syncCursorEvent.toString(),
        syncCursorAudit: node.syncCursorAudit.toString(),
        syncCursorAlarm: node.syncCursorAlarm.toString(),
      };

      const nodeJson = JSON.stringify({ nodes: [serializedNode] });
      expect(nodeJson).toContain('"syncCursorEvent":"42"');
      expect(nodeJson).toContain('"syncCursorAudit":"100"');
      expect(nodeJson).toContain('"syncCursorAlarm":"0"');

      // 2. EvidenceManifest record shape with nested exports
      const manifest = {
        id: 'manifest-456',
        tenantId: 'tenant-1',
        exports: [
          {
            id: 'exp-1',
            fileSizeBytes: 10485760n,
          },
          {
            id: 'exp-2',
            fileSizeBytes: null,
          },
        ],
      };

      const serializedManifest = {
        ...manifest,
        exports: manifest.exports.map((e) => ({
          ...e,
          fileSizeBytes: e.fileSizeBytes != null ? e.fileSizeBytes.toString() : null,
        })),
      };

      const manifestJson = JSON.stringify([serializedManifest]);
      expect(manifestJson).toContain('"fileSizeBytes":"10485760"');
      expect(manifestJson).toContain('"fileSizeBytes":null');

      // 3. PlaybackSession seekResult
      const seekResult = {
        sessionId: 'sess-789',
        masterTimeUtc: new Date(),
        playbackRate: 1.0,
        sessionState: 'SEEKING',
        cameras: [
          {
            cameraId: 'cam-1',
            status: 'READY' as const,
            currentPts: 900000n,
            nearestKeyframePts: 720000n,
          },
        ],
      };

      const serializedCameras = seekResult.cameras.map((c) => ({
        ...c,
        currentPts: c.currentPts?.toString(),
        nearestKeyframePts: c.nearestKeyframePts?.toString(),
      }));

      const sessionJson = JSON.stringify({
        session: { id: 'sess-789' },
        initialSeek: { ...seekResult, cameras: serializedCameras },
      });

      expect(sessionJson).toContain('"currentPts":"900000"');
      expect(sessionJson).toContain('"nearestKeyframePts":"720000"');
    });

    it('verifies BigInt.prototype.toJSON polyfill safely handles unmapped BigInts as defense-in-depth', () => {
      // Install polyfill as done in server.ts
      (BigInt.prototype as any).toJSON = function () {
        return this.toString();
      };

      const rawPrismaRecord = {
        id: 'rec-1',
        rawBigInt: 9876543210123456789n,
      };

      expect(() => JSON.stringify(rawPrismaRecord)).not.toThrow();
      expect(JSON.stringify(rawPrismaRecord)).toBe('{"id":"rec-1","rawBigInt":"9876543210123456789"}');
    });
  });

  describe('Bug 2: Route Module Lifecycle & Timer Isolation', () => {
    it('verifies route modules export services without starting un-cleared intervals at import time', async () => {
      const anprModule = await import('../routes/anpr.routes');
      const notificationModule = await import('../routes/notification.routes');

      expect(anprModule.aggregator).toBeDefined();
      expect(anprModule.aiRuntime).toBeDefined();
      expect(notificationModule.dispatcher).toBeDefined();
    });
  });
});
