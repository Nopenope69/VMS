export type CameraEventProtocol = 'ONVIF_PULLPOINT' | 'HIKVISION_ISAPI' | 'DAHUA_EVENT_MANAGER';

/** A camera analytic event normalised across vendors (becomes a CAMERA_ANALYTIC VigilOneEvent). */
export interface NormalizedCameraEvent {
  protocol: CameraEventProtocol;
  analyticType: string;
  /** true = started, false = stopped, null = instantaneous. */
  state: boolean | null;
  vendorTopic: string;
  /** Camera's own timestamp when it sent one (vendor clock), else null. */
  cameraTimeUtc: Date | null;
  channel?: number;
  ruleName?: string;
  objectType?: string;
  raw?: Record<string, unknown>;
}

export const ANALYTIC_TYPES = [
  'MOTION', 'LINE_CROSSING', 'INTRUSION', 'REGION_ENTRANCE', 'REGION_EXIT', 'LOITERING', 'TAMPER', 'VIDEO_LOSS',
  'SCENE_CHANGE', 'DEFOCUS', 'DIGITAL_INPUT', 'FACE', 'OBJECT_LEFT', 'OBJECT_REMOVED', 'PERSON', 'VEHICLE', 'AUDIO', 'VENDOR_OTHER',
] as const;
