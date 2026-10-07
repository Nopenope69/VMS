/**
 * Central, typed feature-flag registry.
 *
 * Every subsystem that is built but not field-proven sits behind a flag that is OFF by default.
 * A flag is read from the environment at call time (so tests and operators can toggle it without
 * a rebuild): `VIGILONE_FEATURE_<NAME>=true` enables it, anything else leaves it disabled.
 *
 * When a flag is off:
 *   - its HTTP routes answer 501 with code FEATURE_DISABLED (never a fake success),
 *   - its background workers are not started,
 *   - the frontend hides its navigation entry and shows the out-of-scope notice.
 *
 * The README scope table is generated from FEATURE_FLAGS by `npm run docs:feature-flags`.
 */
import { NextFunction, Request, Response } from 'express';

export enum FeatureFlag {
  FEDERATION = 'FEDERATION',
  OBJECT_STORAGE_ARCHIVE = 'OBJECT_STORAGE_ARCHIVE',
  OIDC_SSO = 'OIDC_SSO',
  DIO_RELAY = 'DIO_RELAY',
  ANPR = 'ANPR',
  REDACTION = 'REDACTION',
  SMART_SEARCH = 'SMART_SEARCH',
  FLOORPLANS = 'FLOORPLANS',
  CAMERA_EVENTS = 'CAMERA_EVENTS',
  EXPLANATIONS = 'EXPLANATIONS',
  OBJECT_CROPS = 'OBJECT_CROPS',
  SEMANTIC_SEARCH = 'SEMANTIC_SEARCH',
  VLM_VERIFICATION = 'VLM_VERIFICATION',
  TRACK_INDEX = 'TRACK_INDEX',
  INVESTIGATION_TIMING = 'INVESTIGATION_TIMING',
  NL_SEARCH = 'NL_SEARCH',
  ALARM_TRIAGE = 'ALARM_TRIAGE',
  INCIDENT_SUMMARY = 'INCIDENT_SUMMARY',
  FOOTAGE_SEALING = 'FOOTAGE_SEALING',
  CAMERA_SABOTAGE = 'CAMERA_SABOTAGE',
}

export interface FeatureFlagDefinition {
  flag: FeatureFlag;
  envVar: string;
  title: string;
  /** API prefixes answered with 501 FEATURE_DISABLED while the flag is off. */
  routePrefixes: string[];
  /** Background workers that are only started when the flag is on. */
  workers: string[];
  /** Honest one-line statement of what is and is not real today. */
  status: string;
}

const envVarFor = (flag: FeatureFlag): string => `VIGILONE_FEATURE_${flag}`;

export const FEATURE_FLAGS: Readonly<Record<FeatureFlag, FeatureFlagDefinition>> = Object.freeze({
  [FeatureFlag.FEDERATION]: {
    flag: FeatureFlag.FEDERATION,
    envVar: envVarFor(FeatureFlag.FEDERATION),
    title: 'Multi-site federation',
    routePrefixes: ['/api/v1/federation'],
    workers: ['federationUplink'],
    status:
      'A paired site sends its events, alarm changes and audit entries to headquarters as a hash-chained, signed log that survives link outages; headquarters stores them per site and shows cross-site alarms. Tested with two apps and a cut network link on one machine; not yet run across a real WAN. No live video across sites (reverse tunnel not built).',
  },
  [FeatureFlag.OBJECT_STORAGE_ARCHIVE]: {
    flag: FeatureFlag.OBJECT_STORAGE_ARCHIVE,
    envVar: envVarFor(FeatureFlag.OBJECT_STORAGE_ARCHIVE),
    title: 'S3 / object-storage archive',
    routePrefixes: ['/api/v1/archive'],
    workers: ['archiveWorker'],
    status: 'Finalized segments of enabled tenants are uploaded to S3-compatible storage (SigV4, payload signed with the SHA-256, verified by HEAD) in the off-peak window, pinned evidence first and at any time. Credentials are encrypted and never returned. Tested against a local S3-compatible server (moto) here and MinIO in CI; not yet against a customer bucket.',
  },
  [FeatureFlag.OIDC_SSO]: {
    flag: FeatureFlag.OIDC_SSO,
    envVar: envVarFor(FeatureFlag.OIDC_SSO),
    title: 'Enterprise SSO (OIDC)',
    routePrefixes: ['/api/v1/sso'],
    workers: [],
    status: 'OpenID Connect login (code + PKCE, ID token verified, accounts linked by provider and subject). Tested against oidc-provider (an independent implementation); not yet against a customer identity provider (Entra ID, Okta, Keycloak, Google).',
  },
  [FeatureFlag.DIO_RELAY]: {
    flag: FeatureFlag.DIO_RELAY,
    envVar: envVarFor(FeatureFlag.DIO_RELAY),
    title: 'DI/DO relays and access-control I/O',
    routePrefixes: ['/api/v1/relays', '/api/v1/access'],
    workers: ['DoorMonitor'],
    status: 'Relays and door contacts on Modbus TCP I/O modules: honest handshake (acknowledged by the module, confirmed by coil read-back), door unlock, OPENED / FORCED_OPEN / HELD_OPEN / CLOSED events. Tested against a SIMULATED module (pymodbus), not on real hardware; pins without a module still fail with NO_PHYSICAL_RELAY_DRIVER_ATTACHED.',
  },
  [FeatureFlag.ANPR]: {
    flag: FeatureFlag.ANPR,
    envVar: envVarFor(FeatureFlag.ANPR),
    title: 'ANPR / licence-plate recognition',
    routePrefixes: ['/api/v1/anpr'],
    workers: ['plateTrackAggregator'],
    status: 'Plate reads come from the anpr-worker (PP-OCRv4 detection + fast-plate-ocr, candidate models needing a human licence approval) on cameras in LPR mode; accuracy on Indian site data is not measured yet.',
  },
  [FeatureFlag.REDACTION]: {
    flag: FeatureFlag.REDACTION,
    envVar: envVarFor(FeatureFlag.REDACTION),
    title: 'Video redaction',
    routePrefixes: ['/api/v1/privacy/jobs'],
    workers: [],
    status: 'Jobs verify the source hashes, detect faces/plates through the redaction adapter (candidate models needing a human licence approval), burn opaque masks with ffmpeg, verify and hash the derivative and record it in chain of custody. Recall on site footage is not measured.',
  },
  [FeatureFlag.SMART_SEARCH]: {
    flag: FeatureFlag.SMART_SEARCH,
    envVar: envVarFor(FeatureFlag.SMART_SEARCH),
    title: 'Smart search',
    routePrefixes: ['/api/v1/search'],
    workers: [],
    status:
      'Spatial motion search (stored events inside a box drawn on one camera) and plate search (purpose-limited), both plain SQL over stored events and plate reads. Search by description or photo is separate: SEMANTIC_SEARCH (crops) and TRACK_INDEX (tracks).',
  },
  [FeatureFlag.FLOORPLANS]: {
    flag: FeatureFlag.FLOORPLANS,
    envVar: envVarFor(FeatureFlag.FLOORPLANS),
    title: 'Floorplans',
    routePrefixes: ['/api/v1/floorplans'],
    workers: [],
    status: 'Floorplan CRUD and FOV projection exist; not validated on a real site.',
  },
  [FeatureFlag.CAMERA_EVENTS]: {
    flag: FeatureFlag.CAMERA_EVENTS,
    envVar: envVarFor(FeatureFlag.CAMERA_EVENTS),
    title: 'Camera-native events (ONVIF, Hikvision, Dahua)',
    routePrefixes: ['/api/v1/camera-events'],
    workers: ['cameraEventManager'],
    status: 'ONVIF PullPoint, Hikvision ISAPI and Dahua event clients are tested against local protocol stubs and published formats, not yet against physical cameras.',
  },
  [FeatureFlag.EXPLANATIONS]: {
    flag: FeatureFlag.EXPLANATIONS,
    envVar: envVarFor(FeatureFlag.EXPLANATIONS),
    title: 'Alarm explanations',
    routePrefixes: [],
    workers: [],
    status:
      'Each new alarm gets a template-generated "why was this flagged" record (explain-template.v1, no model), stored and written into evidence packages as explanations.json, where vigilone-verify re-renders and checks it. A failure is audited and logged and never blocks the alarm. Tested on the real database; not yet exercised on a live site.',
  },
  [FeatureFlag.OBJECT_CROPS]: {
    flag: FeatureFlag.OBJECT_CROPS,
    envVar: envVarFor(FeatureFlag.OBJECT_CROPS),
    title: 'Object crop capture',
    routePrefixes: ['/api/v1/crop-policy'],
    workers: ['cropPurger'],
    status:
      'Crops (a JPEG the ai-worker attaches when AI_ATTACH_CROPS is on, or a cut from a detection\'s snapshot image) are stored in CROPS_DIR with a hash, a free-space floor and a hold-aware retention purge. Person crops need a per-site switch with a recorded purpose and are off by default. Not exercised on a live camera site.',
  },
  [FeatureFlag.SEMANTIC_SEARCH]: {
    flag: FeatureFlag.SEMANTIC_SEARCH,
    envVar: envVarFor(FeatureFlag.SEMANTIC_SEARCH),
    title: 'Semantic crop search',
    routePrefixes: ['/api/v1/search/crops'],
    workers: ['cropEmbedder'],
    status:
      'Crops are embedded by the SigLIP 2 adapter (EMBEDDING_ADAPTER_URL) into pgvector and searched by example or by text; results are audited and person searches are admin-only and purpose-limited. The model is owner-approved and matches the official checkpoint; retrieval quality on site data is not measured.',
  },
  [FeatureFlag.VLM_VERIFICATION]: {
    flag: FeatureFlag.VLM_VERIFICATION,
    envVar: envVarFor(FeatureFlag.VLM_VERIFICATION),
    title: 'Alarm second opinion (local VLM)',
    routePrefixes: [],
    workers: ['vlmVerifier'],
    status:
      'A local SmolVLM2 model (llama.cpp, VLM_ADAPTER_URL) is asked whether the detected object is visible in each new alarm\'s snapshot; the yes/no/unclear answer is stored and shown as advisory and never changes the alarm. Answers eight labelled test questions correctly; agreement with operator verdicts on real alarms is not measured. The model needs a human licence approval before it runs.',
  },
  [FeatureFlag.TRACK_INDEX]: {
    flag: FeatureFlag.TRACK_INDEX,
    envVar: envVarFor(FeatureFlag.TRACK_INDEX),
    title: 'Track index (one record per tracked object)',
    routePrefixes: ['/api/v1/tracks'],
    workers: [],
    status:
      'Each tracked person or vehicle gets one record: class, first and last seen, a thinned path, overall direction, visits to the camera\'s named zones, clothing or body colour, and the plate read tied to the vehicle. Colours come from a pixel count in the worker, not a trained model, and are withheld on IR pictures. Search by appearance (text, a stored crop or an uploaded photo, with AND/NOT terms and the same filters; also needs SEMANTIC_SEARCH) returns one result per track. Cross-camera following suggests the same person or vehicle on neighbouring cameras (by appearance) or anywhere (by plate); an operator confirms or rejects each link, and confirmed links form its journey. Person tracks and plates need a declared purpose and are audited. Tested on the real database with synthetic detections and embeddings; accuracy on real cameras and search recall are not measured.',
  },
  [FeatureFlag.INVESTIGATION_TIMING]: {
    flag: FeatureFlag.INVESTIGATION_TIMING,
    envVar: envVarFor(FeatureFlag.INVESTIGATION_TIMING),
    title: 'Time-to-answer stopwatch',
    routePrefixes: ['/api/v1/investigations/timings'],
    workers: [],
    status:
      'An operator starts a stopwatch on the Investigation page when taking a question and stops it as answered or abandoned; searches, opened results, viewed cameras and exports are counted. Times come from the server clock. The site report gives median and 90th-percentile time to answer and the share within 60 s, with no per-operator breakdown. Tested on the real database; no pilot measurement exists yet.',
  },
  [FeatureFlag.NL_SEARCH]: {
    flag: FeatureFlag.NL_SEARCH,
    envVar: envVarFor(FeatureFlag.NL_SEARCH),
    title: 'Plain-language search',
    routePrefixes: ['/api/v1/tracks/parse-query'],
    workers: [],
    status:
      'A request typed in plain English, Hinglish or Hindi ("white SUV at Gate 3 between 8 and 10 pm yesterday, not a taxi") is turned into the track search\'s filters by rules, with the site\'s own camera and zone names and its time zone; the operator sees and can change them before searching. Only a request the word list cannot read (Devanagari place names) is rewritten into English by a local Qwen3-4B model (QUERY_LLM_ADAPTER_URL, needs a human licence approval), and the rules still set every filter. Measured on labelled requests (docs/ai/nl-search-evaluation.md); not yet on real operators\' requests.',
  },
  [FeatureFlag.ALARM_TRIAGE]: {
    flag: FeatureFlag.ALARM_TRIAGE,
    envVar: envVarFor(FeatureFlag.ALARM_TRIAGE),
    title: 'Alarm triage',
    routePrefixes: ['/api/v1/alarm-triage'],
    workers: [],
    status:
      'Open alarms are listed most important first, each with the reasons for its place: severity first, then repeat activity, a passed acknowledge deadline, the advisory second-opinion answer and how operators judged earlier alarms of the same rule on the same camera. Nothing is hidden and nothing changes state. A false-alarm report per camera proposes rule changes (an incident window, or a review of the rule) with the numbers behind them; none is applied. Tested on the real database with synthetic alarms and verdicts; not yet used by operators on a live site.',
  },
  [FeatureFlag.INCIDENT_SUMMARY]: {
    flag: FeatureFlag.INCIDENT_SUMMARY,
    envVar: envVarFor(FeatureFlag.INCIDENT_SUMMARY),
    title: 'Incident summary',
    routePrefixes: ['/api/v1/incident-summaries'],
    workers: [],
    status:
      'An alarm\'s story is written from a numbered timeline of recorded facts (the trigger, earlier events, the linked detection, a journey\'s tracks and operator-confirmed links, repeats, the advisory second opinion, acknowledgement, verdict, resolution, evidence holds) by a fixed template, no model. Every sentence cites the facts it rests on. Number plate text, operators\' typed text and descriptions of people are never repeated. Each summary is hashed, written into the audit chain, stored immutably (a snapshot per set of facts) and goes into evidence packages, where vigilone-verify re-renders it from its facts and checks every citation. Tested on the real database with synthetic alarms; not yet read by investigators on a live site.',
  },
  [FeatureFlag.FOOTAGE_SEALING]: {
    flag: FeatureFlag.FOOTAGE_SEALING,
    envVar: envVarFor(FeatureFlag.FOOTAGE_SEALING),
    title: 'Footage sealing',
    routePrefixes: ['/api/v1/segment-seals'],
    workers: ['segmentSealAnchor'],
    status:
      'Each recorded segment is sealed when it is registered: its SHA-256, times and size are signed with the appliance Ed25519 key and chained to the camera\'s previous seal, and the chain head is written into the audit chain every 15 minutes. A file or stored hash that later differs from its seal is reported as an integrity failure, never resealed. Exports carry the seals, and vigilone-verify checks them offline. Someone with root on the appliance can still read the key; seals stop lesser edits and accidents. Tested on the real database with real files; not run on a live appliance.',
  },
  [FeatureFlag.CAMERA_SABOTAGE]: {
    flag: FeatureFlag.CAMERA_SABOTAGE,
    envVar: envVarFor(FeatureFlag.CAMERA_SABOTAGE),
    title: 'Camera-sabotage detection',
    routePrefixes: [],
    workers: [],
    status:
      'The AI worker (AI_SABOTAGE_DETECTION=true) watches every sampled substream frame for a covered, defocused, moved or blinded camera with classical image measurements (no model) and reports a condition that lasts 10 s once; the backend raises it as a camera-tamper event that SCENE_CHANGE rules turn into alarms. Thresholds were set on four photographs with simulated noise, blur, covers, moves and glare; not run on a real camera, so false-alarm rates on real sites are unknown.',
  },
});

export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = Object.freeze(Object.values(FeatureFlag));

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isFeatureEnabled(flag: FeatureFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FEATURE_FLAGS[flag].envVar];
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

export function getFeatureFlagStates(env: NodeJS.ProcessEnv = process.env): Record<FeatureFlag, boolean> {
  const states = {} as Record<FeatureFlag, boolean>;
  for (const flag of ALL_FEATURE_FLAGS) {
    states[flag] = isFeatureEnabled(flag, env);
  }
  return states;
}

export const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';

/**
 * Express guard: answers 501 FEATURE_DISABLED while the flag is off, otherwise passes through.
 * Evaluated per request so a flag change takes effect without re-mounting routes.
 */
export function requireFeatureFlag(flag: FeatureFlag) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isFeatureEnabled(flag)) {
      return next();
    }
    const def = FEATURE_FLAGS[flag];
    return res.status(501).json({
      error: `${def.title} is disabled on this appliance.`,
      code: FEATURE_DISABLED_CODE,
      feature: flag,
      enableWith: `${def.envVar}=true`,
      status: def.status,
    });
  };
}

/** Markdown table for README generation (scripts/ci/generate-feature-flag-docs.ts). */
export function renderFeatureFlagMarkdownTable(): string {
  const lines = [
    '| Subsystem | Default | Enable with | What is real today |',
    '| --- | --- | --- | --- |',
  ];
  for (const flag of ALL_FEATURE_FLAGS) {
    const def = FEATURE_FLAGS[flag];
    lines.push(`| ${def.title} | OFF (501 \`FEATURE_DISABLED\`) | \`${def.envVar}=true\` | ${def.status} |`);
  }
  return lines.join('\n');
}
