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
  await page.getByLabel('Найти сегмент').fill('1250011604');
  await page.locator('.pipe-table-wrap tbody button').first().click();
  await expect(page.locator('.segment-inspector')).toContainText('1250011604');
  await page.getByRole('tab', { name: 'Дефекты и ВТД', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Развёртка стенки/ })).toBeVisible();
  await page.getByLabel('Дата данных', { exact: true }).selectOption('2018-09-23');
  await expect(page.locator('.plot-legend')).toContainText('скрыт для исторической даты');
  await page.getByLabel('Дата данных', { exact: true }).selectOption('2024-11-24');
  await page.getByLabel('Найти сегмент').fill('');
  await page.screenshot({ path: 'test-results/pipelines-detail.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Прогноз CSV/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('MAIN-2-2024-11-24-result.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString().trim().split('\n');
  expect(lines[0]).toBe('id,segment_id,thickness_pred');
  expect(lines).toHaveLength(581);
  await page.getByLabel('Выбранный трубопровод').selectOption('MAIN-4');
  await expect(page.locator('.segment-inspector')).toContainText('Нет измерений');
  await page.getByRole('tab', { name: 'Паспорт и данные' }).click();
  await expect(page.locator('.passport-grid')).toContainText('1250009583');
  await page.getByRole('button', { name: '← На общую карту' }).click();
  await expect(page.locator('main.layout')).toBeVisible();
  expect(errors).toEqual([]);
});

test('navigation preserves live simulation and explicit teaching leak works', async ({ page }) => {
  await page.goto('/');
  await page.locator('.sc-select select').selectOption('healthy_steady');
  await expect(page.getByRole('button', { name: /Пуск/ })).toBeEnabled();
  await page.locator('.transport select').selectOption('30');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true }).click();
  await page.getByRole('tab', { name: 'Режим и утечки' }).click();
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeEnabled({ timeout: 45_000 });
  await page.getByRole('button', { name: /Пауза/ }).click();
  await expect.poll(async () => {
    const before = await page.locator('.clock .t').textContent();
    await page.waitForTimeout(250);
    return (await page.locator('.clock .t').textContent()) === before;
  }).toBe(true);
  const time = await page.locator('.clock .t').textContent();
  await page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Событие передано');
  await page.getByRole('button', { name: 'На карту и к диагностике →' }).click();
  await expect(page.locator('.clock .t')).toHaveText(time!);
  await expect(page.locator('.inspector h2')).toContainText('коллектор');
  await page.getByRole('button', { name: /Пуск/ }).click();
  await expect.poll(async () => page.locator('.truth-marker').count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('live pipe switches modes, stubs stay closed, corrosion names the breach', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Труба С-1 → Н-1', exact: true }).click();
  await expect(page.locator('.pipe-detail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Трубопровод MAIN-2', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Режим и утечки' }).click();
  await expect(page.getByRole('button', { name: 'Ручная утечка', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Коррозия', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toHaveCount(0);
  await expect(page.getByText('отбраковочная')).toBeVisible();
  await page.getByRole('button', { name: 'Ручная утечка', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← На общую карту' }).click();
  await page.getByRole('button', { name: 'Труба 2: открыть отчёт', exact: true }).click();
  await page.getByRole('tab', { name: 'Режим и утечки' }).click();
  await expect(page.getByRole('button', { name: 'Коррозия', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Внести учебную утечку e4', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← На общую карту' }).click();
  await page.getByRole('button', { name: 'Труба 1: открыть отчёт', exact: true }).click();
  await page.getByRole('tab', { name: 'Режим и утечки' }).click();
  await page.getByRole('button', { name: 'Коррозия', exact: true }).click();
  await page.getByRole('button', { name: 'Пуск суточного счёта', exact: true }).click();
  await expect(page.getByLabel('Дата прорыва')).toHaveText('02.12.2067', { timeout: 120_000 });
  await expect(page.getByTestId('corrosion-result')).toContainText('отбраковочн');
  for (const id of ['D0', 'D1', 'D2']) {
    await expect(page.getByLabel(`Секунды до утечки ${id}`)).not.toHaveText('—', { timeout: 90_000 });
    const text = await page.getByLabel(`Секунды до утечки ${id}`).innerText();
    const seconds = Number(text.replace(/[^\d]/g, ''));
    const hole = Number(await page.getByTestId('corrosion-result').getAttribute('data-hole-start'));
    expect(hole).toBeGreaterThanOrEqual(181);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(180);
    expect(seconds).toBeLessThan(hole);
  }
  expect(errors).toEqual([]);
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
