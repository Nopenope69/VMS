import axios, { AxiosInstance } from 'axios';
import { RecorderState } from '@prisma/client';
import prisma from '../../config/database';
import config from '../../config/env';
import { IMediaProvider, StreamPathConfig, StreamStatus } from './mediaProvider.interface';


export class MediaMTXProvider implements IMediaProvider {
  private client: AxiosInstance;

  constructor(apiUrl = config.MEDIAMTX_API_URL) {
    this.client = axios.create({
      baseURL: apiUrl,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async createOrUpdateStream(streamConfig: StreamPathConfig): Promise<void> {
    const payload = {
      source: streamConfig.sourceRtspUrl,
      sourceOnDemand: false,
      record: streamConfig.record,
    };

    try {
      // Check if path exists
      await this.client.get(`/v3/config/paths/get/${streamConfig.path}`);
      // Path exists, patch it
      await this.client.patch(`/v3/config/paths/patch/${streamConfig.path}`, payload);
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Path does not exist, add it
        await this.client.post(`/v3/config/paths/add/${streamConfig.path}`, payload);
      } else {
        throw new Error(`MediaMTX error configuring path ${streamConfig.path}: ${err.message}`);
      }
    }
  }

  async deleteStream(path: string): Promise<void> {
    try {
      await this.client.delete(`/v3/config/paths/delete/${path}`);
    } catch (err: any) {
      if (err.response?.status !== 404) {
        throw new Error(`MediaMTX error deleting path ${path}: ${err.message}`);
      }
    }
  }

  async getStreamStatus(path: string): Promise<StreamStatus | null> {
    try {
      const res = await this.client.get(`/v3/paths/get/${path}`);
      const data = res.data;
      return {
        ready: Boolean(data.ready),
        readersCount: data.readers?.length || 0,
        tracks: data.tracks || [],
        bytesReceived: data.bytesReceived || 0,
      };
    } catch (err: any) {
      if (err.response?.status === 404) {
        return null;
      }
      return null;
    }
  }

  /**
   * Toggles recording on or off by cameraId.
   * Maps cameraId to MediaMTX streamPath, patches the path config,
   * and updates Camera.recorderState to reflect actual engine status.
   */
  async setRecording(cameraId: string, enabled: boolean): Promise<void> {
    const camera = await prisma.camera.findUnique({
      where: { id: cameraId },
      select: { streamPath: true },
    });

    if (!camera) {
      throw new Error(`Camera ${cameraId} not found`);
    }

    try {
      await this.client.patch(`/v3/config/paths/patch/${camera.streamPath}`, {
        record: enabled,
      });

      // Update actual engine state in the database
      await prisma.camera.update({
        where: { id: cameraId },
        data: {
          recorderState: enabled ? RecorderState.RUNNING : RecorderState.STOPPED,
        },
      });
    } catch (err: any) {
      await prisma.camera.update({
        where: { id: cameraId },
        data: { recorderState: RecorderState.ERROR },
      });
      throw new Error(`MediaMTX error toggling recording for camera ${cameraId}: ${err.message}`);
    }
  }
}

export const mediaProvider = new MediaMTXProvider();
export default mediaProvider;
