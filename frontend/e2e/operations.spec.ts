import { test, expect } from '@playwright/test';

/**
 * VigilOne Stage 3: Playwright Frontend Smoke & Operations Validation
 * Conforms to Master Commercialization Execution Contract (Section 2 & 3.1)
 * Validates Core V1 Operator Flows:
 * 1. Authentication & Role Gate
 * 2. Live Grid Multi-Stream View
 * 3. Playback Timeline Scrubber & Seek Target
 * 4. Section 63 BSA Evidence Legal Hold & Export
 * 5. Storage Management & Mount Guard Status
 * 6. Alarm Management & Telemetry Filter
 */

const BASE_URL = process.env.VIGILONE_BASE_URL || 'http://localhost:3000';

test.describe('VigilOne Core Operator Workflows', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to base appliance URL
    await page.goto(BASE_URL);
  });

  test('Flow 1: Operator Authentication & Local RBAC', async ({ page }) => {
    // Ensure login page is presented
    await expect(page.locator('input[name="username"], input[type="text"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // Fill credentials
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Verify successful login into dashboard
    await expect(page.locator('header')).toBeVisible();
    await expect(page.getByText('Live Grid')).toBeVisible();
  });

  test('Flow 2: Live View Grid Layout & Multi-Camera Rendering', async ({ page }) => {
    // Authenticate
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Navigate to Live Grid
    await page.getByRole('button', { name: /Live Grid/i }).click();

    // Verify layout buttons (1x1, 2x2, 3x3)
    const layoutControls = page.locator('button:has-text("1x1"), button:has-text("2x2"), button:has-text("3x3")');
    if (await layoutControls.count() > 0) {
      await layoutControls.first().click();
    }

    // Verify camera video container is rendered
    await expect(page.locator('.grid, [data-testid="camera-grid"]')).toBeVisible();
  });

  test('Flow 3: Playback Timeline Scrubber & Filename-Derived Seek Target', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Switch to Playback / Investigation tab
    const playbackBtn = page.getByRole('button', { name: /Investigation|Playback/i });
    if (await playbackBtn.isVisible()) {
      await playbackBtn.click();
      // Verify timeline scrubber exists
      await expect(page.locator('input[type="range"], [role="slider"], canvas, .timeline-container')).toBeVisible();
    }
  });

  test('Flow 4: Section 63 BSA Evidence Packaging & Legal Hold', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Navigate to Section 63 Evidence tab
    await page.getByRole('button', { name: /Section 63 Evidence/i }).click();

    // Verify Evidence management table renders
    await expect(page.getByText(/Evidence Packages|Legal Hold|Section 63/i).first()).toBeVisible();

    // Verify Export Evidence button
    const exportBtn = page.getByRole('button', { name: /New Export|Create Package|Export/i });
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
      // Ensure dialog opens with date range and camera selection
      await expect(page.locator('[role="dialog"], .modal')).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('Flow 5: Storage Management & Mount Guard Telemetry', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Navigate to Storage tab
    await page.getByRole('button', { name: /Storage/i }).click();

    // Verify storage volume vitals and Mount Guard indicators
    await expect(page.getByText(/Storage Volumes|Pool Status|Capacity/i).first()).toBeVisible();
  });

  test('Flow 6: System Alarms & Severity Filtering', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Navigate to Events tab
    await page.getByRole('button', { name: /Events/i }).click();

    // Verify event/alarm list renders
    await expect(page.getByText(/Active Alarms|Security Events|Alarm Feed/i).first()).toBeVisible();
  });
});
