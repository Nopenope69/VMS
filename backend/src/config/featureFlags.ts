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
    workers: [],
    status:
      'Pairing, control-tunnel protocol and sync engine exist; no outbound WAN client runs, so appliances do not sync across sites.',
  },
  [FeatureFlag.OBJECT_STORAGE_ARCHIVE]: {
    flag: FeatureFlag.OBJECT_STORAGE_ARCHIVE,
    envVar: envVarFor(FeatureFlag.OBJECT_STORAGE_ARCHIVE),
    title: 'S3 / object-storage archive',
    routePrefixes: ['/api/v1/archive'],
    workers: [],
    status: 'Scheduling and checksum logic exist; no S3 client is attached and uploads fail closed.',
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
    routePrefixes: ['/api/v1/relays'],
    workers: [],
    status: 'Handshake state machine exists; no GPIO/serial/Modbus driver is attached (NO_PHYSICAL_RELAY_DRIVER_ATTACHED).',
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
    status: 'Plain SQL over DetectionEvent rows; there is no embedding or semantic search yet.',
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
      'Crop embeddings are stored in pgvector and searched by example (a stored crop or a vector); results are audited and person crops are purpose-limited. There is no embedding model yet (the SigLIP 2 adapter and text queries are not built), so nothing is embedded until an adapter is configured, and retrieval quality on site data is not measured.',
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
