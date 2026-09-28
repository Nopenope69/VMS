import { NormalizedCameraEvent } from '../types';

/**
 * Maps ONVIF event notifications (wsnt:NotificationMessage) onto normalised analytic types.
 * Topics follow the ONVIF topic namespace (tns1:...). The boolean state is the first Data
 * SimpleItem whose value is a boolean (IsMotion, State, IsInside, IsTamper, LogicalState...);
 * events without one (LineDetector/Crossed) are instantaneous. PropertyOperation
 * "Initialized" messages describe the state at subscription time and are not events.
 */
const TOPIC_RULES: Array<[RegExp, string]> = [
  [/CellMotionDetector\/Motion$|VideoSource\/MotionAlarm$|MotionRegionDetector\/Motion$/i, 'MOTION'],
  [/LineDetector\/Crossed$|LineCrossing/i, 'LINE_CROSSING'],
  [/FieldDetector\/ObjectsInside$|Intrusion/i, 'INTRUSION'],
  [/Loitering/i, 'LOITERING'],
  [/TamperDetector\/Tamper$|GlobalSceneChange/i, 'TAMPER'],
  [/ImageTooBlurry/i, 'DEFOCUS'],
  [/ImageTooDark|ImageTooBright/i, 'SCENE_CHANGE'],
  [/VideoSource\/SignalLoss|VideoLoss/i, 'VIDEO_LOSS'],
  [/Device\/Trigger\/DigitalInput|Device\/IO\/Port|DigitalInput/i, 'DIGITAL_INPUT'],
  [/PeopleDetect|HumanDetect|Person/i, 'PERSON'],
  [/VehicleDetect|Vehicle/i, 'VEHICLE'],
  [/FaceDetect/i, 'FACE'],
  [/ObjectLeft|LeftBehind|Unattended/i, 'OBJECT_LEFT'],
  [/ObjectRemoved|Removed/i, 'OBJECT_REMOVED'],
  [/AudioAnalytics|AudioAlarm|DetectedSound/i, 'AUDIO'],
];

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function simpleItems(node: any): Array<{ name: string; value: string }> {
  return asArray(node?.SimpleItem).map((s: any) => ({ name: String(s?.$?.Name ?? ''), value: String(s?.$?.Value ?? '') }));
}

export function topicToAnalyticType(topic: string): string {
  for (const [re, t] of TOPIC_RULES) if (re.test(topic)) return t;
  return 'VENDOR_OTHER';
}

export function parseNotificationMessages(pullResponse: any): NormalizedCameraEvent[] {
  const out: NormalizedCameraEvent[] = [];
  for (const nm of asArray(pullResponse?.NotificationMessage)) {
    const topicNode = nm?.Topic;
    const topic = String(typeof topicNode === 'string' ? topicNode : topicNode?._ ?? '').trim();
    const msg = nm?.Message?.Message;
    if (!topic || !msg) continue;
    const op = String(msg?.$?.PropertyOperation ?? '');
    if (op === 'Initialized' || op === 'Deleted') continue;
    const data = simpleItems(msg.Data);
    const source = simpleItems(msg.Source);
    const boolItem = data.find((d) => /^(true|false)$/i.test(d.value));
    const utc = msg?.$?.UtcTime ? new Date(msg.$.UtcTime) : null;
    const rule = source.find((s) => /^Rule$/i.test(s.name))?.value;
    const channelToken = source.find((s) => /VideoSource.*Token|InputToken|Source$/i.test(s.name))?.value;
    const objectType = data.find((d) => /^(ObjectType|ClassTypes?|Type)$/i.test(d.name))?.value;
    out.push({
      protocol: 'ONVIF_PULLPOINT',
      analyticType: topicToAnalyticType(topic),
      state: boolItem ? boolItem.value.toLowerCase() === 'true' : null,
      vendorTopic: topic,
      cameraTimeUtc: utc && !isNaN(utc.getTime()) ? utc : null,
      ...(rule ? { ruleName: rule } : {}),
      ...(objectType ? { objectType } : {}),
      raw: { propertyOperation: op || null, source: channelToken ?? null, data: Object.fromEntries(data.map((d) => [d.name, d.value])) },
    });
  }
  return out;
}
