/**
 * Go-live readiness check (live deployment). Answers "is this installation safe to put in front of real users?"
 * with one line per item:
 *
 *   BLOCK   must be fixed before go-live (the command exits 1);
 *   WARN    allowed, but someone must knowingly accept it (listed in the report);
 *   PASS    checked and fine;
 *   MANUAL  cannot be checked from the software; a named person signs it off.
 *
 * collectSnapshot() reads the running system (database, environment, disk, clock); evaluate() is pure, so every
 * rule is unit-tested. Run on an appliance with `vigilonectl golive` (docs/operations/GO_LIVE_RUNBOOK.md).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { FEATURE_FLAGS, FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { KNOWN_DEV_ENCRYPTION_KEY } from '../config/env';
import { AuditChainService } from '../services/audit/auditChain.service';

export type Verdict = 'BLOCK' | 'WARN' | 'PASS' | 'MANUAL';
export interface CheckResult {
  id: string;
  verdict: Verdict;
  title: string;
  detail: string;
}

export interface Snapshot {
  env: Record<string, string | undefined>;
  enabledFlags: FeatureFlag[];
  bootstrapped: boolean;
  superAdmins: number;
  activeUsers: number;
  failedMigrations: string[];
  auditChains: { tenantId: string; valid: boolean; error?: string }[];
  cameras: { total: number; continuous: number };
  camerasWithoutRecentSegment: string[];
  disk: { path: string; freeFraction: number } | null;
  ntpSynchronized: boolean | null;
  modelExceptionsFile: { path: string; testOnly: boolean } | null;
  haLeaseHolder: string | null;
}

/** Features that were only verified against simulators or stand-ins: what the site still has to prove. */
const SITE_VALIDATION: Partial<Record<FeatureFlag, string>> = {
  [FeatureFlag.DIO_RELAY]: 'door relays and contacts were tested on a SIMULATED module; test each door on site (forced, held open, unlock)',
  [FeatureFlag.OIDC_SSO]: 'tested against a test identity provider only; sign in once with the customer identity provider and check role mapping',
  [FeatureFlag.OBJECT_STORAGE_ARCHIVE]: 'tested against a local S3 server; upload and read back one segment from the customer bucket',
  [FeatureFlag.ANPR]: 'plate accuracy on this site is not measured; review a sample of reads before relying on them',
  [FeatureFlag.REDACTION]: 'redaction recall on this site is not measured; review a redacted export before release',
};

export function evaluate(s: Snapshot): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (id: string, verdict: Verdict, title: string, detail: string) => out.push({ id, verdict, title, detail });
  const env = s.env;

  // --- configuration -----------------------------------------------------------------------------------------
  add('config.production', env.NODE_ENV === 'production' ? 'PASS' : 'BLOCK', 'Production mode', env.NODE_ENV === 'production' ? 'NODE_ENV=production (the backend refuses published default secrets in this mode)' : `NODE_ENV=${env.NODE_ENV ?? '(unset)'}: development defaults and test stores are allowed`);
  const jwt = env.JWT_SECRET ?? '';
  const jwtPublished = /change_me|vigilone_dev/i.test(jwt);
  add('config.jwt_secret', jwt.length >= 32 && !jwtPublished ? 'PASS' : 'BLOCK', 'JWT signing secret', jwtPublished ? 'a published placeholder or development secret: anyone can forge logins' : jwt.length >= 32 ? 'set, 32+ characters' : `${jwt.length} characters; generate at least 32 random characters`);
  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  add('config.credential_key', key && key !== KNOWN_DEV_ENCRYPTION_KEY ? 'PASS' : key ? 'BLOCK' : 'WARN', 'Credential encryption key', !key ? 'not in the environment; the backend reads /etc/vigilone/appliance.key in production (make sure it exists and is backed up separately)' : key === KNOWN_DEV_ENCRYPTION_KEY ? 'the published development key; every stored camera, S3 and SSO secret is readable by anyone' : 'set (keep an offline copy: without it stored secrets cannot be decrypted after a restore)');
  if (s.enabledFlags.includes(FeatureFlag.OIDC_SSO)) {
    const url = env.VIGILONE_PUBLIC_URL;
    add('config.public_url', url && url.startsWith('https://') ? 'PASS' : 'BLOCK', 'Public URL for single sign-on', url ? url : 'VIGILONE_PUBLIC_URL is not set; the SSO callback cannot be built in production');
  }

  // --- data and integrity ------------------------------------------------------------------------------------
  add('db.migrations', s.failedMigrations.length ? 'BLOCK' : 'PASS', 'Database migrations', s.failedMigrations.length ? `failed or unfinished: ${s.failedMigrations.join(', ')}` : 'all applied');
  add('system.bootstrapped', s.bootstrapped && s.superAdmins > 0 ? 'PASS' : 'BLOCK', 'First-run setup', s.bootstrapped ? `${s.superAdmins} super administrator(s), ${s.activeUsers} active user(s)` : 'the appliance has not been bootstrapped');
  const broken = s.auditChains.filter((c) => !c.valid);
  add('audit.chain', broken.length ? 'BLOCK' : 'PASS', 'Audit log integrity', broken.length ? `chain broken for tenant(s) ${broken.map((b) => `${b.tenantId} (${b.error ?? 'invalid'})`).join('; ')}` : `${s.auditChains.length} tenant chain(s) verified`);

  // --- recording ---------------------------------------------------------------------------------------------
  if (s.cameras.total === 0) add('cameras.configured', 'WARN', 'Cameras', 'no camera configured; go-live usually needs the site cameras added and recording');
  else add('cameras.configured', 'PASS', 'Cameras', `${s.cameras.total} configured, ${s.cameras.continuous} recording continuously`);
  if (s.cameras.continuous > 0) {
    const n = s.camerasWithoutRecentSegment.length;
    add('recording.recent', n ? 'BLOCK' : 'PASS', 'Recording is happening', n ? `${n} continuously recording camera(s) finished no segment in the last 30 minutes: ${s.camerasWithoutRecentSegment.slice(0, 10).join(', ')}` : 'every continuously recording camera finished a segment in the last 30 minutes');
  }
  if (!s.disk) add('storage.free', 'WARN', 'Recording disk', 'recordings directory not found or not readable');
  else {
    const pct = Math.round(s.disk.freeFraction * 100);
    add('storage.free', pct < 5 ? 'BLOCK' : pct < 15 ? 'WARN' : 'PASS', 'Recording disk', `${pct}% free on ${s.disk.path}`);
  }

  // --- time, models, availability ----------------------------------------------------------------------------
  add('clock.ntp', s.ntpSynchronized === true ? 'PASS' : s.ntpSynchronized === false ? 'BLOCK' : 'MANUAL', 'Clock synchronised (NTP)', s.ntpSynchronized === null ? 'could not ask timedatectl; check the host clock is NTP-synchronised (evidence timestamps depend on it)' : s.ntpSynchronized ? 'synchronised' : 'not synchronised: evidence timestamps and log correlation are unreliable');
  if (s.modelExceptionsFile?.testOnly) add('models.test_only_approvals', 'BLOCK', 'Model approvals', `${s.modelExceptionsFile.path} contains TEST-ONLY approvals; product use needs the owner's recorded approvals`);
  else add('models.test_only_approvals', 'PASS', 'Model approvals', s.modelExceptionsFile ? `${s.modelExceptionsFile.path} has no TEST-ONLY entries` : 'using the repository approvals file');
  if (env.VIGILONE_HA_NODE_ID) add('ha.lease', s.haLeaseHolder ? 'PASS' : 'WARN', 'High availability', s.haLeaseHolder ? `leader: ${s.haLeaseHolder}` : 'no node holds the lease: background services are not running anywhere');

  // --- enabled features that still need site validation --------------------------------------------------------
  for (const f of s.enabledFlags) {
    const need = SITE_VALIDATION[f];
    if (need) add(`feature.${f}`, 'WARN', `${FEATURE_FLAGS[f].title} is ON`, need);
  }

  // --- human sign-offs ---------------------------------------------------------------------------------------
  for (const [id, title, detail] of [
    ['signoff.acceptance', 'Installation acceptance checklist', 'run `vigilonectl acceptance` and have the field engineer sign the MANUAL items (INSTALLATION_ACCEPTANCE_CHECKLIST.md)'],
    ['signoff.dpdp', 'DPDP decision record', 'the data fiduciary signs DPDP_DECISION_RECORD.md (lawful basis, retention, notices at the site)'],
    ['signoff.backup_restore', 'Backup and restore drill', 'take a backup and restore it on a spare machine (BACKUP_AND_RESTORE_RUNBOOK.md); keep the credential key offline'],
    ['signoff.tls', 'TLS certificate', 'replace the self-signed certificate with the customer certificate'],
    ['signoff.handover', 'Customer handover', 'CUSTOMER_HANDOVER_PROCEDURE.md: admin credentials handed over, bootstrap token destroyed, support contacts'],
  ] as const) add(id, 'MANUAL', title, detail);

  return out;
}

export async function collectSnapshot(prisma: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<Snapshot> {
  const enabledFlags = (Object.values(FeatureFlag) as FeatureFlag[]).filter((f) => isFeatureEnabled(f, env as NodeJS.ProcessEnv));
  const state = await prisma.applianceState.findUnique({ where: { id: 'SINGLETON' } });
  const superAdmins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', active: true } });
  const activeUsers = await prisma.user.count({ where: { active: true } });
  const failed = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`;
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const auditChains = [];
  for (const t of tenants) {
    const r = await AuditChainService.verifyChain(prisma, t.id);
    auditChains.push({ tenantId: t.id, valid: r.valid, error: r.error });
  }
  const total = await prisma.camera.count();
  // Continuous recorders must produce segments all the time; motion and scheduled ones may legitimately be idle.
  const recordingCams = await prisma.camera.findMany({ where: { recordingMode: 'CONTINUOUS' }, select: { id: true, name: true } });
  const since = new Date(Date.now() - 30 * 60_000);
  const camerasWithoutRecentSegment: string[] = [];
  for (const c of recordingCams) {
    const seg = await prisma.recordingSegment.findFirst({ where: { cameraId: c.id, endTime: { gte: since } }, select: { id: true } });
    if (!seg) camerasWithoutRecentSegment.push(c.name);
  }
  const recDir = env.RECORDINGS_DIR || '/var/lib/vigilone/recordings';
  let disk: Snapshot['disk'] = null;
  try {
    const st = fs.statfsSync(recDir);
    disk = { path: recDir, freeFraction: st.bavail / st.blocks };
  } catch {
    disk = null;
  }
  let ntpSynchronized: boolean | null = null;
  try {
    ntpSynchronized = execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'yes';
  } catch {
    ntpSynchronized = null;
  }
  let modelExceptionsFile: Snapshot['modelExceptionsFile'] = null;
  if (env.VIGILONE_MODEL_EXCEPTIONS) {
    const p = env.VIGILONE_MODEL_EXCEPTIONS;
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    modelExceptionsFile = { path: p, testOnly: /TEST-ONLY/.test(text) };
  }
  let haLeaseHolder: string | null = null;
  if (env.VIGILONE_HA_NODE_ID) {
    const rows = await prisma.$queryRaw<{ holderId: string }[]>`SELECT "holderId" FROM "ClusterLease" WHERE "name" = 'background-services' AND "expiresAt" >= now()`;
    haLeaseHolder = rows[0]?.holderId ?? null;
  }
  return {
    env,
    enabledFlags,
    bootstrapped: Boolean(state?.isBootstrapped) || superAdmins > 0,
    superAdmins,
    activeUsers,
    failedMigrations: failed.map((f) => f.migration_name),
    auditChains,
    cameras: { total, continuous: recordingCams.length },
    camerasWithoutRecentSegment,
    disk,
    ntpSynchronized,
    modelExceptionsFile,
    haLeaseHolder,
  };
}

export function render(results: CheckResult[]): string {
  const order: Verdict[] = ['BLOCK', 'WARN', 'MANUAL', 'PASS'];
  const lines = [...results].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict)).map((r) => `${r.verdict.padEnd(6)} ${r.title}: ${r.detail}`);
  const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const summary = n('BLOCK') ? `NOT READY: ${n('BLOCK')} blocking item(s)` : `READY TO GO LIVE once the ${n('MANUAL')} manual sign-off(s) are done and the ${n('WARN')} warning(s) are accepted`;
  return [...lines, '', summary].join('\n');
}
