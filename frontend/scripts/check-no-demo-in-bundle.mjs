// Fails if any demo-only string survives into the production bundle in dist/.
// Usage: npm run build && node scripts/check-no-demo-in-bundle.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const { strings } = JSON.parse(fs.readFileSync(path.join(here, 'demo-bundle-denylist.json'), 'utf8'));

if (!fs.existsSync(dist)) {
  console.error('dist/ not found: run `npm run build` first');
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|html|css|map)$/.test(entry.name)) files.push(full);
  }
};
walk(dist);

const hits = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const s of strings) {
    if (content.includes(s)) hits.push(`${path.relative(dist, file)}: "${s}"`);
  }
}

if (hits.length > 0) {
  console.error('❌ Demo-only strings found in production bundle (was it built with VITE_DEMO_MODE=true?):');
  for (const h of hits) console.error(`   ${h}`);
  process.exit(1);
}
console.log(`✅ Production bundle clean: ${files.length} files scanned, ${strings.length} demo strings absent.`);
