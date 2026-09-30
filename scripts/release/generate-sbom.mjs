#!/usr/bin/env node
/**
 * Software bill of materials for a VigilOne release (Phase 8, certification preparation), in CycloneDX 1.5 JSON:
 *
 *   - production npm dependencies of backend, frontend and services/ai-worker (from `npm sbom`, which reads the
 *     committed lockfiles, no install needed);
 *   - every AI model pinned in scripts/models/models.lock.json (product models and candidate models, marked),
 *     as machine-learning-model components with their SHA-256, source URL and code / weights licences;
 *   - pinned third-party binaries and images named in docker-compose.yml.
 *
 *   node scripts/release/generate-sbom.mjs [out-dir]      (default: dist-sbom/)
 *
 * Writes one file per project plus vigilone-sbom.cdx.json (all merged), and fails when a component has no
 * version, a model has no SHA-256, or a licence is missing.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] || path.join(repo, 'dist-sbom'));
fs.mkdirSync(out, { recursive: true });
const problems = [];

function npmSbom(project) {
  const cwd = path.join(repo, project);
  const raw = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--sbom-type', 'application', '--package-lock-only'], { cwd, maxBuffer: 256 << 20 }).toString();
  const bom = JSON.parse(raw);
  const file = path.join(out, `${project.replace(/\//g, '-')}.cdx.json`);
  fs.writeFileSync(file, JSON.stringify(bom, null, 2));
  for (const c of bom.components || []) {
    if (!c.version) problems.push(`${project}: ${c.name} has no version`);
  }
  return bom;
}

function modelComponents() {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/models/models.lock.json'), 'utf8'));
  const list = [...lock.models.map((m) => ({ ...m, candidate: false })), ...(lock.candidateModels || []).map((m) => ({ ...m, candidate: true }))];
  return list.map((m) => {
    if (!/^[0-9a-f]{64}$/.test(m.sha256 || '')) problems.push(`model ${m.key}: no SHA-256`);
    if (!m.codeLicense || !m.weightLicense) problems.push(`model ${m.key}: licence missing`);
    return {
      type: 'machine-learning-model',
      'bom-ref': `model:${m.key}`,
      name: m.name,
      version: m.version,
      hashes: [{ alg: 'SHA-256', content: m.sha256 }],
      licenses: [...new Set([m.codeLicense, m.weightLicense])].filter(Boolean).map((id) => ({ license: { id } })),
      externalReferences: [{ type: 'distribution', url: m.url }],
      properties: [
        { name: 'vigilone:model-key', value: m.key },
        { name: 'vigilone:task', value: m.task || '' },
        { name: 'vigilone:code-license', value: m.codeLicense || '' },
        { name: 'vigilone:weights-license', value: m.weightLicense || '' },
        // Candidate models need a recorded human approval (scripts/models/model-license-exceptions.json) to run.
        { name: 'vigilone:candidate-model', value: String(m.candidate) },
        ...(m.trainingData?.source ? [{ name: 'vigilone:training-data', value: `${m.trainingData.source} (${m.trainingData.license || 'licence not stated'})` }] : []),
      ],
    };
  });
}

function imageComponents() {
  const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
  const images = [...compose.matchAll(/^\s*image:\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1]);
  return [...new Set(images)].map((ref) => {
    const at = ref.lastIndexOf(':');
    const digest = ref.includes('@sha256:') ? ref.split('@sha256:')[1] : null;
    const name = digest ? ref.split('@')[0] : at > ref.lastIndexOf('/') ? ref.slice(0, at) : ref;
    const version = digest ? `sha256:${digest}` : at > ref.lastIndexOf('/') ? ref.slice(at + 1) : 'latest';
    // vigilone-* images are built from this repository (their contents are the npm and model components above).
    const firstParty = name.startsWith('vigilone-');
    if (version === 'latest' && !firstParty) problems.push(`image ${ref}: not pinned`);
    return { type: 'container', 'bom-ref': `image:${ref}`, name, version, ...(digest ? { hashes: [{ alg: 'SHA-256', content: digest }] } : {}), properties: [{ name: 'vigilone:first-party', value: String(firstParty) }] };
  });
}

const projects = ['backend', 'frontend', 'services/ai-worker'];
const boms = projects.map(npmSbom);
const seen = new Set();
const components = [];
for (const b of boms) {
  for (const c of b.components || []) {
    const key = c.purl || `${c.name}@${c.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push(c);
  }
}
const models = modelComponents();
const images = imageComponents();
let version = '0.0.0';
try {
  version = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: repo }).toString().trim();
} catch {
  /* not a git checkout */
}
const merged = {
  $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'VigilOne', name: 'scripts/release/generate-sbom.mjs', version: '1' }],
    component: { type: 'application', 'bom-ref': 'vigilone', name: 'VigilOne VMS', version },
  },
  components: [...components, ...models, ...images],
};
fs.writeFileSync(path.join(out, 'vigilone-sbom.cdx.json'), JSON.stringify(merged, null, 2));
console.log(`SBOM: ${components.length} npm packages, ${models.length} AI models, ${images.length} container images -> ${path.join(out, 'vigilone-sbom.cdx.json')}`);
if (problems.length) {
  for (const p of problems) console.error(`PROBLEM ${p}`);
  process.exit(1);
}
