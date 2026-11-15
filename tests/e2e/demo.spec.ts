import { test, expect, type Page } from '@playwright/test';

async function simTime(page: Page): Promise<number> {
  const txt = (await page.locator('.clock .t').textContent()) ?? '00:00.0';
  const [m, s] = txt.split(':');
  return Number(m) * 60 + Number(s);
}

test('demo flow: run, operator leak injection, independent diagnosis, export to files and backend, reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} ${m.location()?.url ?? ''}`);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Пуск/ })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('.scenario-note')).toHaveCount(0);
  await page.locator('.transport select').selectOption('30');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await expect.poll(() => simTime(page), { timeout: 120_000 }).toBeGreaterThan(200);
  await expect(page.locator('.det-card').nth(1).locator('.badge')).toHaveText('норма');
  // select a pipe, inject an abrupt leak as operator
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '← На общую карту', exact: true }).click();
  await expect(page.locator('.inspector h2')).toHaveText('У-1 → У-2 (коллектор)');
  await page.getByRole('tab', { name: 'Эксперимент' }).click();
  await page.getByRole('button', { name: 'Внести утечку' }).click();
  // diagnostics must reach a confirmed leak from measurements only
  await expect(page.locator('.det-card').nth(1)).toContainText('утечка', { timeout: 120_000 });
  await expect(page.locator('.det-card').nth(1).locator('.badge')).toHaveText('подтверждено', { timeout: 120_000 });
  // pause and export
  await page.getByRole('button', { name: /Пауза/ }).click();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Экспорт' }).click();
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(downloads.some((d) => d.endsWith('measurements.csv'))).toBe(true);
  // the same run is stored by the backend: measurements, diagnoses and the separate ground truth
  await expect(page.getByText('Прогон сохранён на сервере.')).toBeVisible({ timeout: 60_000 });
  const runId = downloads.find((d) => d.endsWith('-report.json'))!.replace(/-report\.json$/, '');
  const rep = await page.request.get(`http://127.0.0.1:8000/api/runs/${runId}/report`);
  expect(rep.ok()).toBe(true);
  const stored = (await rep.json()) as { measurements: { samples: number }; finalDiagnoses: Record<string, unknown>; groundTruth?: { events: Array<{ kind: string }> } };
  expect(stored.measurements.samples).toBeGreaterThan(1000);
  expect(Object.keys(stored.finalDiagnoses)).toContain('D1');
  expect(stored.groundTruth?.events.some((e) => e.kind === 'leak')).toBe(true);
  // reset keeps the scenario and restarts physics from t = 0
  await page.getByRole('button', { name: /Сброс/ }).click();
  await expect.poll(() => simTime(page)).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/demo-final.png', fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('backend offline: simulation and baseline diagnostics keep working', async ({ page }) => {
  await page.route('**/127.0.0.1:8000/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Пуск/ })).toBeEnabled({ timeout: 30_000 });
  await page.locator('.transport select').selectOption('30');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await expect.poll(() => simTime(page), { timeout: 60_000 }).toBeGreaterThan(30);
  await expect(page.locator('.diag-panel')).toContainText('D1');
});
