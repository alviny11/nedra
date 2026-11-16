import { createHash } from 'node:crypto';
import reproduction from '../../backend/reproduction/spec.json';
import { test, expect } from '@playwright/test';

test('map, dossier, dates, selected segment, export and unknown measurements', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true })).toBeVisible();
  await expect(page.locator('.pipeline-hub')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Труба [12]: открыть отчёт/ })).toHaveCount(2);
  await page.screenshot({ path: 'test-results/pipelines-map.png', fullPage: true });
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Трубопровод MAIN-2', exact: true })).toBeVisible();
  await expect(page.locator('.segment-inspector')).toContainText('1250009490');
  await expect(page.locator('.segment-inspector .value-accent')).toHaveText('—');
  await expect(page.locator('.stat-word')).toHaveText('Random Forest');
  await expect(page.locator('.pipe-stats')).toContainText('3,39');
  await expect(page.getByText('Постоянная скорость')).toHaveCount(0);
  await page.getByLabel('Найти сегмент').fill('1250022871');
  await page.locator('.segment-forecast tbody button').first().click();
  await expect(page.locator('.segment-inspector')).toContainText('1250022871');
  await expect(page.locator('.segment-inspector .value-accent')).toHaveText(/5,93/);
  await page.getByLabel('Найти сегмент').fill('1250011604');
  await page.locator('.segment-forecast tbody button').first().click();
  await expect(page.locator('.segment-inspector')).toContainText('1250011604');
  await expect(page.locator('.segment-inspector .value-accent')).toHaveText('—');
  await expect(page.getByRole('tab', { name: 'Дефекты и ВТД' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Прогноз', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Развёртка стенки/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Как получен прогноз', exact: true })).toBeVisible();
  await page.getByLabel('Дата данных', { exact: true }).selectOption('2018-09-23');
  await expect(page.locator('.plot-legend')).toContainText('скрыт для исторической даты');
  await page.getByLabel('Найти сегмент').fill('1250022871');
  await page.locator('.segment-forecast tbody button').first().click();
  await expect(page.locator('.segment-inspector .value-accent')).toHaveText('—');
  await expect(page.locator('.segment-forecast tbody tr').first().locator('td').nth(4)).toHaveText('—');
  await expect(page.locator('.pipe-stats > div').first().locator('strong')).toHaveText('—');
  await expect(page.locator('.forecast-point')).toHaveCount(0);
  await expect(page.locator('.history-points')).not.toContainText('06.07.2022');

  await page.getByLabel('Дата данных', { exact: true }).selectOption('forecast');
  await expect(page.locator('.segment-inspector .value-accent')).toHaveText(/5,93/);
  await page.getByLabel('Найти сегмент').fill('');
  await expect(page.locator('.segment-forecast tbody tr')).toHaveCount(10);
  await page.screenshot({ path: 'test-results/pipelines-detail.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /result\.csv · Random Forest/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('result.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(reproduction.reconstructed_result_sha256);
  const lines = bytes.toString().trim().split('\n');
  expect(lines[0]).toBe('id,segment_id,thickness_pred');
  expect(lines).toHaveLength(2001);
  expect(lines[1]).toBe('1250022871,0,5.926620');
  expect(lines[2]).toBe('1250022871,1,6.537313');
  expect(lines[526]).toBe('1250009583,0,4.2615');
  await page.getByLabel('Выбранный трубопровод').selectOption('MAIN-4');
  await expect(page.locator('.segment-inspector')).toContainText('Нет измерений');
  await expect(page.locator('.stat-word')).toHaveText('Высотный профиль');
  await expect(page.locator('.pipe-stats')).toContainText('3,04');
  await expect(page.locator('.segment-forecast tbody tr').first()).toContainText('4,26');
  await page.getByRole('tab', { name: 'Паспорт и данные' }).click();
  await expect(page.locator('.passport-grid')).toContainText('1250009583');
  await expect(page.locator('.passport-sources')).toContainText('Высотный профиль');
  await page.getByRole('button', { name: '← На общую карту' }).click();
  await expect(page.locator('main.layout')).toBeVisible();
  expect(errors).toEqual([]);
});

test('navigation preserves live simulation and explicit teaching leak works', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.scenario-note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Пуск/ })).toBeEnabled();
  await page.locator('.transport select').selectOption('30');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await page.getByRole('button', { name: /Пауза/ }).click();
  const time = await page.locator('.clock .t').textContent();
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true }).click();
  await expect(page.locator('.topbar')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Режим и утечки' }).click();
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeEnabled({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Событие передано');
  await page.getByRole('button', { name: 'На карту и к диагностике →' }).click();
  await expect(page.locator('.clock .t')).toHaveText(time!);
  await expect(page.locator('.inspector h2')).toContainText('коллектор');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await expect.poll(async () => page.locator('.truth-marker').count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('both pipe cards keep manual leaks without a failure-date mode', async ({ page }) => {
  await page.goto('/');
  for (const number of [1, 2]) {
    await page.getByRole('button', { name: `Труба ${number}: открыть отчёт`, exact: true }).click();
    await page.getByRole('tab', { name: 'Режим и утечки' }).click();
    await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Коррозия', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Дата прорыва')).toHaveCount(0);
    await page.getByRole('button', { name: '← На общую карту' }).click();
  }
});

test('mobile detail keeps controls reachable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Труба 2: открыть отчёт', exact: true }).click();
  await expect(page.getByLabel('Дата данных', { exact: true })).toBeVisible();
  const overflow = await page.locator('.pipe-detail').evaluate(el => el.scrollWidth > el.clientWidth+1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: 'test-results/pipelines-mobile.png', fullPage: true });
});
