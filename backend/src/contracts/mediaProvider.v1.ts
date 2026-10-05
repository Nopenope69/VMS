/**
 * media-provider.v1: the interface VigilOne uses to drive a media engine (today MediaMTX).
 * Spec: docs/contracts/media-provider.v1.md. This wraps the existing IMediaProvider without
 * refactoring it (P0.7: document and wrap).
 *
 * The provider distinguishes an absent path from an unavailable engine. Neither state contains
 * invented telemetry.
 */
import { z } from 'zod';
import { IMediaProvider } from '../services/media/mediaProvider.interface';
import { UtcTimestamp } from './common';

export const MEDIA_PROVIDER_CONTRACT = 'media-provider.v1' as const;

/** MediaMTX-compatible path names: letters, digits, _ - / . (no traversal, no leading slash). */
export const StreamPathV1 = z
  .string()
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./]{1,128}$/, 'invalid stream path');

export const StreamPathConfigV1 = z
  .object({
    path: StreamPathV1,
    sourceRtspUrl: z.string().regex(/^rtsps?:\/\/[^\s]+$/, 'source must be an rtsp:// or rtsps:// URL'),
    record: z.boolean(),
  })
  .strict();

export const StreamStatusV1 = z
  .object({
    contract: z.literal(MEDIA_PROVIDER_CONTRACT),
    path: StreamPathV1,
    state: z.enum(['READY', 'NOT_READY', 'NOT_FOUND', 'ENGINE_UNAVAILABLE']),
    readersCount: z.number().int().nonnegative().nullable(),
    tracks: z.array(z.string()).nullable(),
    bytesReceived: z.number().int().nonnegative().nullable(),
    observedAtUtc: UtcTimestamp,
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.state === 'NOT_FOUND' || s.state === 'ENGINE_UNAVAILABLE') && (s.readersCount !== null || s.tracks !== null || s.bytesReceived !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no telemetry may be reported for a path that was not observed' });
    }
  });

export type StreamPathConfigV1 = z.infer<typeof StreamPathConfigV1>;
export type StreamStatusV1 = z.infer<typeof StreamStatusV1>;

export interface MediaProviderV1 {
  readonly contract: typeof MEDIA_PROVIDER_CONTRACT;
  createOrUpdateStream(config: StreamPathConfigV1): Promise<void>;
  deleteStream(path: string): Promise<void>;
  getStreamStatus(path: string): Promise<StreamStatusV1>;
  setRecording(cameraId: string, enabled: boolean): Promise<void>;
}

export class MediaProviderV1Adapter implements MediaProviderV1 {
  public readonly contract = MEDIA_PROVIDER_CONTRACT;

  constructor(private readonly inner: IMediaProvider, private readonly now: () => Date = () => new Date()) {}

  async createOrUpdateStream(config: StreamPathConfigV1): Promise<void> {
    await this.inner.createOrUpdateStream(StreamPathConfigV1.parse(config));
  }

  async deleteStream(path: string): Promise<void> {
    await this.inner.deleteStream(StreamPathV1.parse(path));
  }

  async getStreamStatus(path: string): Promise<StreamStatusV1> {
    const validPath = StreamPathV1.parse(path);
    const raw = await this.inner.getStreamStatus(validPath);
    const observedAtUtc = this.now().toISOString();
    if (raw.kind !== 'OBSERVED') {
      return StreamStatusV1.parse({
        contract: MEDIA_PROVIDER_CONTRACT,
        path: validPath,
        state: raw.kind,
        readersCount: null,
        tracks: null,
        bytesReceived: null,
        observedAtUtc,
      });
    }
    return StreamStatusV1.parse({
      contract: MEDIA_PROVIDER_CONTRACT,
      path: validPath,
      state: raw.ready ? 'READY' : 'NOT_READY',
      readersCount: raw.readersCount,
      tracks: raw.tracks,
      bytesReceived: raw.bytesReceived,
      observedAtUtc,
    });
  }

  async setRecording(cameraId: string, enabled: boolean): Promise<void> {
    await this.inner.setRecording(cameraId, enabled);
  }
}
