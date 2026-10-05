export interface StreamPathConfig {
  path: string;
  sourceRtspUrl: string;
  record: boolean;
}

export interface ObservedStreamStatus {
  kind: 'OBSERVED';
  ready: boolean;
  readersCount: number;
  tracks: string[];
  bytesReceived: number;
}

/** A stream status is either observed, absent from the engine, or unavailable because the engine could not answer. */
export type StreamStatus = ObservedStreamStatus | { kind: 'NOT_FOUND' } | { kind: 'ENGINE_UNAVAILABLE' };

export interface IMediaProvider {
  /**
   * Creates or updates a stream path in the media engine.
   */
  createOrUpdateStream(config: StreamPathConfig): Promise<void>;

  /**
   * Deletes a stream path from the media engine.
   */
  deleteStream(path: string): Promise<void>;

  /**
   * Fetches the current live status of a stream path.
   */
  getStreamStatus(path: string): Promise<StreamStatus>;

  /**
   * Toggles recording on or off for a given camera ID.
   * Maps cameraId to media path internally and updates recorderState.
   */
  setRecording(cameraId: string, enabled: boolean): Promise<void>;
}
