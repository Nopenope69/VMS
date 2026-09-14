import fs from 'fs';
import path from 'path';

/**
 * Frontend Ergonomics, Tactical Palette & Keyboard Navigation Test Suite
 *
 * Verifies:
 * 1. Navbar hotkey keydown listeners (keys 1-9, 0) with active input/textarea suppression.
 * 2. Complete absence of broken Tailwind class 'py-0.2' across all frontend sources.
 * 3. Section 63 BSA legal disclaimers maintain >= 14px font size in clean font-sans.
 * 4. Human action buttons are stripped of pseudo-cyberpunk bracket chrome [ ... ].
 * 5. All modal dialogs implement keyboard Escape dismissal and ARIA accessibility semantics.
 * 6. Bespoke tactical surveillance color tokens and font fallback stacks in tailwind config and index.css.
 */

describe('Frontend Ergonomics & Keyboard Navigation Validation', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const frontendSrc = path.join(rootDir, 'frontend/src');

  // Helper to recursively collect all .tsx and .ts files
  function getFrontendFiles(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(getFrontendFiles(fullPath));
      } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  it('verifies Navbar implements functional hotkey listeners for tabs 1-9 and 0', () => {
    const navbarPath = path.join(frontendSrc, 'components/Navbar.tsx');
    expect(fs.existsSync(navbarPath)).toBe(true);
    const content = fs.readFileSync(navbarPath, 'utf8');

    // Keydown listener registered and cleaned up
    expect(content).toContain("window.addEventListener('keydown', handleKeyDown)");
    expect(content).toContain("window.removeEventListener('keydown', handleKeyDown)");

    // Guard against typing in form inputs/textareas
    expect(content).toMatch(/activeTag === 'input'\s*\|\|\s*activeTag === 'textarea'/);

    // Number key mappings handled for nav items
    expect(content).toContain("item.index === e.key");

    // Hotkey badges styled with tactical badge utility
    expect(content).toContain('badge-hotkey');
  });

  it('verifies zero occurrences of invalid Tailwind class py-0.2 across all frontend source files', () => {
    const allFiles = getFrontendFiles(frontendSrc);
    const violations: { file: string; line: number }[] = [];

    for (const filePath of allFiles) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (line.includes('py-0.2')) {
          violations.push({ file: path.relative(frontendSrc, filePath), line: idx + 1 });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('verifies Section 63 BSA legal disclaimers maintain legible font size (>= 14px) and sans typography', () => {
    const cssPath = path.join(frontendSrc, 'index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // .legal-disclaimer must enforce text-[14px] and font-sans
    expect(cssContent).toContain('.legal-disclaimer');
    expect(cssContent).toMatch(/\.legal-disclaimer\s*\{[^}]*text-\[14px\]/);
    expect(cssContent).toMatch(/\.legal-disclaimer\s*\{[^}]*font-sans/);

    // FirstRunWizard must consume .legal-disclaimer for Section 63 BSA notice
    const wizardPath = path.join(frontendSrc, 'pages/FirstRunWizard.tsx');
    const wizardContent = fs.readFileSync(wizardPath, 'utf8');
    expect(wizardContent).toContain('legal-disclaimer');
    expect(wizardContent).toContain('Section 63');

    // Evidence registry description must be font-sans and >= 14px
    const evidencePath = path.join(frontendSrc, 'pages/Evidence.tsx');
    const evidenceContent = fs.readFileSync(evidencePath, 'utf8');
    expect(evidenceContent).toContain('font-sans');
    expect(evidenceContent).toMatch(/text-\[14px\]/);

    // EvidenceExportModal must consume .legal-disclaimer
    const exportModalPath = path.join(frontendSrc, 'components/EvidenceExportModal.tsx');
    const exportModalContent = fs.readFileSync(exportModalPath, 'utf8');
    expect(exportModalContent).toContain('legal-disclaimer');
  });

  it('verifies action buttons across primary consoles are stripped of bracket chrome', () => {
    const pageFiles = [
      'pages/Devices.tsx',
      'pages/Playback.tsx',
      'pages/Evidence.tsx',
      'pages/Events.tsx',
      'pages/ApplianceConsole.tsx',
      'pages/Users.tsx',
      'pages/License.tsx',
      'pages/StorageManagement.tsx',
      'components/AlarmBanner.tsx',
      'components/EvidenceExportModal.tsx',
    ];

    const forbiddenButtonPatterns = [
      /\[\s*\+\s*ONBOARD/i,
      /\[\s*\+\s*ENROLL/i,
      /\[\s*REFRESH\s*\]/i,
      /\[\s*APPLY\s+LICENSE/i,
      /\[\s*DOWNLOAD\s+BUNDLE/i,
      /\[\s*SEAL\s*&\s*GENERATE/i,
      /\[\s*CANCEL\s*\]/i,
      /\[\s*SMART FORENSIC SEARCH\s*\]/i,
    ];

    for (const relativePath of pageFiles) {
      const fullPath = path.join(frontendSrc, relativePath);
      if (!fs.existsSync(fullPath)) continue;
      const fileContent = fs.readFileSync(fullPath, 'utf8');

      for (const pattern of forbiddenButtonPatterns) {
        expect(fileContent).not.toMatch(pattern);
      }
    }
  });

  it('verifies modal dialogs implement keyboard Escape dismissal and ARIA role=dialog', () => {
    const modalFiles = [
      'components/ObjectStorageArchiveModal.tsx',
      'components/SmartSearchModal.tsx',
      'components/EvidenceExportModal.tsx',
      'components/EvidenceReviewModal.tsx',
      'components/NotificationSettingsModal.tsx',
      'components/BackupModal.tsx',
      'pages/Users.tsx',
      'pages/License.tsx',
      'pages/Devices.tsx',
      'pages/Events.tsx',
      'pages/StorageManagement.tsx',
    ];

    for (const relPath of modalFiles) {
      const fullPath = path.join(frontendSrc, relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Must listen for Escape key
      expect(content).toMatch(/e\.key\s*===\s*['"]Escape['"]/);

      // Must implement ARIA dialog semantics
      expect(content).toContain('role="dialog"');
      expect(content).toContain('aria-modal="true"');
    }
  });

  it('verifies Tailwind configuration provides bespoke tactical avionics palette and robust font fallbacks', () => {
    const tailwindConfigPath = path.join(rootDir, 'frontend/tailwind.config.js');
    expect(fs.existsSync(tailwindConfigPath)).toBe(true);
    const configContent = fs.readFileSync(tailwindConfigPath, 'utf8');

    // Bespoke tactical colors defined
    expect(configContent).toContain("canvas: '#07090E'");
    expect(configContent).toContain("panel: '#0C1017'");
    expect(configContent).toContain("surface: '#121721'");
    expect(configContent).toContain("amber: '#F59E0B'");
    expect(configContent).toContain("cyan: '#38BDF8'");
    expect(configContent).toContain("green: '#10B981'");
    expect(configContent).toContain("red: '#EF4444'");

    // Font fallbacks: sans and mono have system fallbacks, no single hardcoded font assumption
    expect(configContent).toContain('ui-sans-serif');
    expect(configContent).toContain('ui-monospace');
  });

  it('verifies index.css defines tactile feedback and tactical button utility classes', () => {
    const cssPath = path.join(frontendSrc, 'index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    expect(cssContent).toContain('.btn-tactical-primary');
    expect(cssContent).toContain('.btn-tactical-secondary');
    expect(cssContent).toContain('.btn-tactical-danger');
    expect(cssContent).toContain('.input-tactical');
    expect(cssContent).toContain('active:translate-y-[1px]');
    expect(cssContent).toContain('focus-visible:ring-1');
  });
});
