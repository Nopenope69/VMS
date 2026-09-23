import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

interface HygieneViolation {
  category: string;
  file?: string;
  message: string;
}

function runHygieneCheck() {
  const violations: HygieneViolation[] = [];
  const repoRoot = path.resolve(__dirname, '../../..');
  const backendDir = path.resolve(__dirname, '../..');

  console.log('🔍 Running VigilOne Repository Corruption Hygiene Gate...');

  // 1. Check for suspicious or placeholder files in the repo root
  const rootFiles = fs.readdirSync(repoRoot);
  for (const file of rootFiles) {
    if (file === '...' || file.startsWith('...')) {
      violations.push({
        category: 'Suspicious Artifact',
        file,
        message: `Found illegal/placeholder filename in root: "${file}"`,
      });
    }
  }

  // 2. Critical file size sanity thresholds
  const criticalFiles = [
    { relativePath: 'README.md', minBytes: 4000, maxBytes: 50000 },
    { relativePath: 'PROJECT_STATE.md', minBytes: 20000, maxBytes: 150000 },
  ];

  for (const cf of criticalFiles) {
    const fullPath = path.join(repoRoot, cf.relativePath);
    if (!fs.existsSync(fullPath)) {
      violations.push({
        category: 'Missing Core File',
        file: cf.relativePath,
        message: `Critical document "${cf.relativePath}" does not exist.`,
      });
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.size < cf.minBytes) {
      violations.push({
        category: 'File Truncation Anomaly',
        file: cf.relativePath,
        message: `File size ${stat.size} bytes is suspiciously small (min expected ${cf.minBytes} bytes). Indicates potential truncation/wipeout.`,
      });
    } else if (stat.size > cf.maxBytes) {
      violations.push({
        category: 'File Bloat Anomaly',
        file: cf.relativePath,
        message: `File size ${stat.size} bytes exceeds expected maximum (${cf.maxBytes} bytes).`,
      });
    }
  }

  // 3. Inspect git diff for unexpected destructive changes
  let gitDiffStatus = '';
  try {
    // Try diff against master or origin/master
    const baseBranch = execSync('git rev-parse --verify master 2>/dev/null || git rev-parse --verify origin/master', {
      cwd: repoRoot,
    })
      .toString()
      .trim();

    gitDiffStatus = execSync(`git diff --name-status ${baseBranch}...HEAD`, { cwd: repoRoot })
      .toString()
      .trim();
  } catch (err: any) {
    console.warn('⚠️ Unable to run git diff against master/origin/master; checking uncommitted diff instead.');
    try {
      gitDiffStatus = execSync('git diff --name-status HEAD', { cwd: repoRoot }).toString().trim();
    } catch {
      gitDiffStatus = '';
    }
  }

  if (gitDiffStatus) {
    console.log('\n--- Git Diff Status ---');
    console.log(gitDiffStatus);
    console.log('-----------------------\n');

    const lines = gitDiffStatus.split('\n');
    const protectedFiles = ['README.md', 'PROJECT_STATE.md', 'backend/prisma/schema.prisma'];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const statusCode = parts[0];
      const filePath = parts[1];

      // Check if critical files were deleted
      if (statusCode === 'D' && protectedFiles.includes(filePath)) {
        violations.push({
          category: 'Destructive Deletion',
          file: filePath,
          message: `Protected file "${filePath}" was deleted!`,
        });
      }

      // Check if file name itself is anomalous
      if (filePath && (path.basename(filePath) === '...' || filePath.includes('...'))) {
        violations.push({
          category: 'Corrupted File Addition',
          file: filePath,
          message: `Suspicious placeholder filename detected in diff: "${filePath}"`,
        });
      }
    }
  }

  // 4. TypeScript Syntax & Parser Sanity for test and service files
  const testDir = path.join(backendDir, 'src/__tests__');
  if (fs.existsSync(testDir)) {
    const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));
    for (const tf of testFiles) {
      const testPath = path.join(testDir, tf);
      const content = fs.readFileSync(testPath, 'utf8');

      // Check for trivial/stub test files
      if (content.trim().length < 200 || content.trim() === '...' || !content.includes('describe(')) {
        violations.push({
          category: 'Test File Corruption',
          file: `backend/src/__tests__/${tf}`,
          message: `Test file appears corrupted or empty (${content.length} bytes, missing describe block).`,
        });
      }

      // TypeScript parse validation
      const sourceFile = ts.createSourceFile(tf, content, ts.ScriptTarget.Latest, true);
      const diagnostics = (sourceFile as any).parseDiagnostics || [];
      if (diagnostics.length > 0) {
        violations.push({
          category: 'TypeScript Syntax Error',
          file: `backend/src/__tests__/${tf}`,
          message: `Found ${diagnostics.length} syntax/parser diagnostics in test file.`,
        });
      }
    }
  }

  // 5. Check privacy service file size and placeholder checks
  const privacyServicePath = path.join(backendDir, 'src/services/privacy/videoRedactor.service.ts');
  if (fs.existsSync(privacyServicePath)) {
    const content = fs.readFileSync(privacyServicePath, 'utf8');
    if (content.trim() === '...' || content.length < 500) {
      violations.push({
        category: 'Service File Corruption',
        file: 'backend/src/services/privacy/videoRedactor.service.ts',
        message: 'videoRedactor.service.ts is truncated or corrupted.',
      });
    }

    const sourceFile = ts.createSourceFile(
      'videoRedactor.service.ts',
      content,
      ts.ScriptTarget.Latest,
      true
    );
    const diagnostics = (sourceFile as any).parseDiagnostics || [];
    if (diagnostics.length > 0) {
      violations.push({
        category: 'TypeScript Syntax Error',
        file: 'backend/src/services/privacy/videoRedactor.service.ts',
        message: `Found ${diagnostics.length} syntax/parser diagnostics in service file.`,
      });
    }
  }

  // Report results
  if (violations.length > 0) {
    console.error('\n❌ Repository hygiene check FAILED with violations:');
    for (const v of violations) {
      console.error(`  - [${v.category}] ${v.file ? `(${v.file}) ` : ''}${v.message}`);
    }
    process.exit(1);
  }

  console.log('✅ Repository corruption hygiene gate PASSED. All invariants verified cleanly.\n');
}

runHygieneCheck();
