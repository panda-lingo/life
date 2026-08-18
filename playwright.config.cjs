const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 *
 * Two projects share the same base URL but differ in viewport + user agent:
 *   - desktop: Chrome at 1280x720
 *   - mobile:  Pixel-7 viewport / Touch / mobile UA — also runs against redroid
 *
 * WebGL is enabled in both projects via Chrome flags. The mobile project is
 * what GitHub Actions uses against the redroid-emulated Android browser.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // The explore-mode e2e test waits up to 45s on `#hud input` because two
  // sequential backend AI calls + headless STT degradation can push the
  // total time well past the Playwright default of 30s. Raise the global
  // timeout so the enclosing test has headroom for that locator assertion
  // (a locator timeout cannot exceed its parent test timeout).
  timeout: process.env.CI ? 90_000 : 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: './test-results',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
        },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
});