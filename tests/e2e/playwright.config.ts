import { defineConfig } from '@playwright/test';

/**
 * Uses the locally installed Chrome; the app is served by `vite preview` from apps/web/dist and the
 * FastAPI backend runs on :8000 (the offline test blocks it per page with page.route).
 */
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { executablePath: process.env.PIPETWIN_CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] },
    viewport: { width: 1500, height: 1000 },
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
      cwd: '../../apps/web',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: 'python -m uvicorn app.main:app --port 8000 --host 127.0.0.1',
      cwd: '../../backend',
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: true,
      timeout: 60_000
    }
  ]
});
