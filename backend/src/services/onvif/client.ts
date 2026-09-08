import { Cam } from 'onvif';

export interface OnvifCredentials {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
}

export interface OnvifDeviceInfo {
  manufacturer: string;
  model: string;
  firmwareVersion: string;
  serialNumber: string;
  hardwareId: string;
}

export interface OnvifStreamUris {
  mainStreamUri: string;
  subStreamUri?: string;
  hasPtz: boolean;
  profiles: Array<{ token: string; name: string }>;
}

export class OnvifClientManager {
  private connectionCache = new Map<string, { cam: Cam; lastUsed: number }>();
  private CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

  private getCacheKey(creds: OnvifCredentials): string {
    return `${creds.hostname}:${creds.port}:${creds.username || ''}`;
  }

  async getCam(creds: OnvifCredentials): Promise<Cam> {
    const key = this.getCacheKey(creds);
    const cached = this.connectionCache.get(key);

    if (cached && Date.now() - cached.lastUsed < this.CACHE_TTL_MS) {
      cached.lastUsed = Date.now();
      return cached.cam;
    }

    const cam = await new Promise<Cam>((resolve, reject) => {
      const c = new Cam(
        {
          hostname: creds.hostname,
          port: creds.port,
          username: creds.username,
          password: creds.password,
          timeout: 10000,
        },
        (err) => {
          if (err) {
            reject(new Error(`ONVIF connection to ${creds.hostname}:${creds.port} failed: ${err.message}`));
          } else {
            resolve(c);
          }
        }
      );
    });

    this.connectionCache.set(key, { cam, lastUsed: Date.now() });
    return cam;
  }

  async getDeviceInformation(creds: OnvifCredentials): Promise<OnvifDeviceInfo> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      cam.getDeviceInformation((err, info) => {
        if (err || !info) {
          resolve({
            manufacturer: 'Generic ONVIF',
            model: 'Camera',
            firmwareVersion: '1.0.0',
            serialNumber: 'UNKNOWN',
            hardwareId: 'UNKNOWN',
          });
        } else {
          resolve({
            manufacturer: info.manufacturer || 'Generic',
            model: info.model || 'Camera',
            firmwareVersion: info.firmwareVersion || 'Unknown',
            serialNumber: info.serialNumber || 'Unknown',
            hardwareId: info.hardwareId || 'Unknown',
          });
        }
      });
    });
  }

  async resolveStreamUris(creds: OnvifCredentials): Promise<OnvifStreamUris> {
    const cam = await this.getCam(creds);
    const profiles = (cam as any).profiles || [];

    if (profiles.length === 0) {
      throw new Error(`No ONVIF media profiles found on device ${creds.hostname}`);
    }

    const mainProfile = profiles[0];
    const subProfile = profiles.length > 1 ? profiles[1] : undefined;

    // Check PTZ capability
    const hasPtz = Boolean((cam as any).capabilities?.PTZ);

    const mainStreamUri = await new Promise<string>((resolve, reject) => {
      cam.getStreamUri({ protocol: 'RTSP', profileToken: mainProfile.$.token }, (err, stream) => {
        if (err || !stream?.uri) {
          reject(new Error(`Failed to get main stream URI: ${err?.message || 'No URI returned'}`));
        } else {
          resolve(stream.uri);
        }
      });
    });

    let subStreamUri: string | undefined;
    if (subProfile) {
      try {
        subStreamUri = await new Promise<string>((resolve, reject) => {
          cam.getStreamUri({ protocol: 'RTSP', profileToken: subProfile.$.token }, (err, stream) => {
            if (err || !stream?.uri) {
              reject(err);
            } else {
              resolve(stream.uri);
            }
          });
        });
      } catch {
        subStreamUri = undefined;
      }
    }

    // Embed credentials into RTSP URL if not present
    const embedAuth = (uri: string) => {
      if (creds.username && creds.password && uri.startsWith('rtsp://') && !uri.includes('@')) {
        const afterScheme = uri.substring(7);
        const encodedUser = encodeURIComponent(creds.username);
        const encodedPass = encodeURIComponent(creds.password);
        return `rtsp://${encodedUser}:${encodedPass}@${afterScheme}`;
      }
      return uri;
    };

    return {
      mainStreamUri: embedAuth(mainStreamUri),
      subStreamUri: subStreamUri ? embedAuth(subStreamUri) : undefined,
      hasPtz,
      profiles: profiles.map((p: any) => ({ token: p.$.token, name: p.name || p.$.token })),
    };
  }

  async ptzContinuousMove(
    creds: OnvifCredentials,
    profileToken: string,
    velocity: { x: number; y: number; zoom?: number }
  ): Promise<void> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      cam.continuousMove(
        {
          profileToken,
          velocity: {
            x: velocity.x,
            y: velocity.y,
            zoom: velocity.zoom || 0,
          },
        },
        (err) => {
          if (err) {
            reject(new Error(`PTZ ContinuousMove failed: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  async ptzStop(creds: OnvifCredentials, profileToken: string): Promise<void> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      cam.stop(
        {
          profileToken,
          panTilt: true,
          zoom: true,
        },
        (err) => {
          if (err) {
            reject(new Error(`PTZ Stop failed: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  async getPresets(
    creds: OnvifCredentials,
    profileToken: string
  ): Promise<Array<{ token: string; name: string }>> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      (cam as any).getPresets({ profileToken }, (err: any, presetsObj: any) => {
        if (err) {
          return reject(new Error(`ONVIF GetPresets failed: ${err.message}`));
        }
        const list: Array<{ token: string; name: string }> = [];
        if (presetsObj && typeof presetsObj === 'object') {
          for (const key of Object.keys(presetsObj)) {
            const p = presetsObj[key];
            list.push({
              token: p.$?.token || key,
              name: p.name || key,
            });
          }
        }
        resolve(list);
      });
    });
  }

  async setPreset(
    creds: OnvifCredentials,
    profileToken: string,
    presetName: string,
    presetToken?: string
  ): Promise<string> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      (cam as any).setPreset(
        { profileToken, presetName, presetToken },
        (err: any, res: any) => {
          if (err) {
            return reject(new Error(`ONVIF SetPreset failed: ${err.message}`));
          }
          const token = res?.setPresetResponse?.presetToken || presetToken || presetName;
          resolve(token);
        }
      );
    });
  }

  async gotoPreset(
    creds: OnvifCredentials,
    profileToken: string,
    presetToken: string,
    speed?: number
  ): Promise<void> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      (cam as any).gotoPreset(
        { profileToken, preset: presetToken, speed },
        (err: any) => {
          if (err) {
            return reject(new Error(`ONVIF GotoPreset failed: ${err.message}`));
          }
          resolve();
        }
      );
    });
  }

  async removePreset(
    creds: OnvifCredentials,
    profileToken: string,
    presetToken: string
  ): Promise<void> {
    const cam = await this.getCam(creds);

    return new Promise((resolve, reject) => {
      (cam as any).removePreset(
        { profileToken, presetToken },
        (err: any) => {
          if (err) {
            return reject(new Error(`ONVIF RemovePreset failed: ${err.message}`));
          }
          resolve();
        }
      );
    });
  }
}

export const onvifManager = new OnvifClientManager();
export default onvifManager;
