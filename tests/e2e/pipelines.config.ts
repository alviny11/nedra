import { defineConfig } from '@playwright/test';
// Run against an already started frontend; no backend needed for this feature.
export default defineConfig({ testDir: '.', testMatch: 'pipelines.spec.ts', workers: 1,
  timeout: 60_000, use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 } },
  outputDir: '../../test-results/pipelines' });
