declare module 'onvif' {
  export interface CamOptions {
    hostname: string;
    port?: number;
    username?: string;
    password?: string;
    timeout?: number;
    path?: string;
  }

  export class Cam {
    constructor(options: CamOptions, callback: (err?: Error) => void);
    getDeviceInformation(callback: (err?: Error, info?: any) => void): void;
    getProfiles(callback: (err?: Error, profiles?: any[]) => void): void;
    getStreamUri(options: { protocol: string; profileToken: string }, callback: (err?: Error, stream?: { uri: string }) => void): void;
    continuousMove(options: { profileToken: string; velocity: { x: number; y: number; zoom?: number } }, callback: (err?: Error) => void): void;
    stop(options: { profileToken: string; panTilt?: boolean; zoom?: boolean }, callback: (err?: Error) => void): void;
    capabilities: any;
    profiles: any[];
  }

  export const Discovery: {
    probe(options: { timeout?: number }, callback: (err?: Error, cams?: any[]) => void): void;
  };
}
