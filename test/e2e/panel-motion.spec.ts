import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSidePanel } from './side-panel-fixture';

// Sample real painted geometry, rather than merely checking that a transition
// is declared. Click in the browser so Playwright cannot wait out the motion.
async function record(group: Locator, control: Locator) {
  const button = (await control.elementHandle())!;
  return group.evaluate(async (group, button) => {
    const frames: { visible: string[]; active: number; expanded: number; error: number; verticalError: number; leaking: number; x: Record<string, number> }[] = [];
    const tabTops = new Map([...group.querySelectorAll<HTMLElement>('[data-edge-tab]')]
      .map(tab => [tab.dataset.edgeTab!, tab.querySelector('button')!.getBoundingClientRect().top]));
    (button as HTMLElement).click();
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      // AHRS keeps its existing confirmation; accept Background when switching.
      const confirmation = document.querySelector<HTMLDialogElement>('.ahrs-stow-dialog');
      if (confirmation?.matches(':modal')) [...confirmation.querySelectorAll('button')]
        .find(button => button.textContent === 'Background')!.click();
      const right = group.classList.contains('is-right');
      const edge = group.getBoundingClientRect();
      const visible: string[] = [], x: Record<string, number> = {};
      let error = 0, verticalError = 0;
      for (const tab of group.querySelectorAll<HTMLElement>('[data-edge-tab]')) {
        const button = tab.querySelector('button')!;
        const handle = button.getBoundingClientRect();
        const name = tab.dataset.edgeTab!;
        if (!tabTops.has(name)) tabTops.set(name, handle.top);
        verticalError = Math.max(verticalError, Math.abs(handle.top - tabTops.get(name)!));
        const inset = parseFloat(getComputedStyle(tab).getPropertyValue('--edge-tool-inset')) || 0;
        if (!tab.closest('.is-presented')) error = Math.max(error, Math.abs(right ? handle.right - edge.right : handle.left - edge.left - inset));
        const body = document.getElementById(button.getAttribute('aria-controls')!)!;
        if (getComputedStyle(body).visibility !== 'visible' || !body.getClientRects().length) continue;
        const box = body.getBoundingClientRect();
        visible.push(name); x[name] = box.x;
        error = Math.max(error, Math.abs(right ? handle.right - box.left : handle.left - box.right));
      }
      frames.push({ visible, x, error, verticalError, active: group.querySelectorAll('.edge-panel.is-open').length,
        leaking: [...group.querySelectorAll('.edge-panel:not(.is-presented) .edge-panel-body *')]
          .filter(element => getComputedStyle(element).visibility === 'visible' && element.getClientRects().length).length,
        expanded: group.querySelectorAll('[aria-expanded="true"]').length });
    } while (performance.now() - start < 480);
    return frames;
  }, button);
}

async function settled(group: Locator, name: string | null) {
  await expect.poll(() => group.evaluate((group, name) => {
    const selected = group.querySelector('[aria-expanded="true"]')?.closest<HTMLElement>('[data-edge-tab]')?.dataset.edgeTab ?? null;
    const visible = [...group.querySelectorAll<HTMLElement>('[data-edge-tab]')].filter(tab => {
      const body = document.getElementById(tab.querySelector('button')!.getAttribute('aria-controls')!)!;
      return getComputedStyle(body).visibility === 'visible' && body.getClientRects().length;
    }).map(tab => tab.dataset.edgeTab);
    return selected === name && visible.length === (name ? 1 : 0) && (!name || visible[0] === name) &&
      group.getAnimations().every(animation => animation.playState !== 'running');
  }, name)).toBe(true);
}

function tab(group: Locator, name: string) { return group.locator(`[data-edge-tab="${name}"] button`); }

async function select(group: Locator, name: string | null) {
  const current = await group.locator('[aria-expanded="true"]').count();
  if (name && await tab(group, name).getAttribute('aria-expanded') !== 'true') await record(group, tab(group, name));
  else if (!name && current) await record(group, group.locator('[aria-expanded="true"]'));
  await settled(group, name);
}

function assertMotion(frames: Awaited<ReturnType<typeof record>>, names: string[]) {
  expect(Math.max(...frames.map(frame => frame.error)), 'each tab follows its own panel; stowed tabs stay at the screen edge').toBeLessThan(1);
  expect(Math.max(...frames.map(frame => frame.verticalError)), 'tab slots stay vertically fixed throughout the slide').toBeLessThan(1);
  for (const frame of frames) {
    expect(frame.active).toBeLessThanOrEqual(1);
    expect(frame.expanded).toBeLessThanOrEqual(1);
    expect(frame.visible.length, 'outgoing and incoming panels never overlap').toBeLessThanOrEqual(1);
    expect(frame.leaking, 'no descendants can paint through a hidden panel').toBe(0);
  }
  for (const name of names) {
    const positions = frames.flatMap(frame => frame.x[name] === undefined ? [] : [Math.round(frame.x[name]!)]);
    expect(new Set(positions).size, `${name} actually slides`).toBeGreaterThan(2);
  }
}

async function airport(page: Page) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  return page.locator('.search-results button').filter({ hasText: 'KSBA' });
}

async function openPanels(page: Page) {
  await page.goto('/');
  await (await airport(page)).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await settled(page.locator('.side-panels'), 'plate');
}

test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null })));
});

for (const [width, height] of [[393, 852], [568, 320], [1280, 900]] as const) {
  test(`every right-side transition slides at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const group = page.locator('.side-panels');
    assertMotion(await record(group, await airport(page)), ['details']);
    await settled(group, 'details');
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    assertMotion(await record(group, page.getByRole('button', { name: /TEST APPROACH/ })), ['details', 'plate']);
    await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
    for (const from of ['details', 'plate']) {
      for (const to of [null, 'details', 'plate']) {
        if (from === to) continue;
        await select(group, from);
        assertMotion(await record(group, tab(group, to ?? from)), to ? [from, to] : [from]);
        await settled(group, to);
        if (to === null) {
          const plateTab = (await tab(group, 'plate').boundingBox())!;
          const attribution = (await page.locator('.maplibregl-ctrl-attrib-button').boundingBox())!;
          expect(plateTab.y + plateTab.height <= attribution.y || attribution.x + attribution.width <= plateTab.x,
            'stowed tabs clear the map attribution control').toBe(true);
        }
        // Reopening either panel after either was stowed must animate too.
        if (to === null) for (const reopen of ['details', 'plate']) {
          assertMotion(await record(group, tab(group, reopen)), [reopen]);
          await settled(group, reopen);
          await select(group, null);
        }
      }
    }
    await select(group, 'plate');
    assertMotion(await record(group, page.getByRole('button', { name: 'Close plate', exact: true })), ['plate']);
    await expect(page.locator('.procedure-panel')).toHaveCount(0);
    await select(group, 'details');
    assertMotion(await record(group, page.getByRole('button', { name: 'Close detail', exact: true })), ['details']);
    await expect(page.locator('.feature-details-panel')).toHaveCount(0);
    // A later new selection must slide again, even though the old panel unmounted.
    assertMotion(await record(group, await airport(page)), ['details']);
    await settled(group, 'details');
    await page.screenshot({ path: testInfo.outputPath('reopened-details.png') });
  });

  test(`every left-side pair slides at ${width}×${height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
    await route.fill('KSBA KSMO');
    await route.press('Enter');
    const group = page.locator('.map-edge-tools .edge-panels');
    for (const from of ['charts', 'gps', 'ahrs', 'terrain']) {
      for (const to of [null, 'charts', 'gps', 'ahrs', 'terrain']) {
        if (from === to) continue;
        await select(group, from);
        assertMotion(await record(group, tab(group, to ?? from)), to ? [from, to] : [from]);
        await settled(group, to);
        if (to === null) for (const reopen of ['charts', 'gps', 'ahrs', 'terrain']) {
          assertMotion(await record(group, tab(group, reopen)), [reopen]);
          await settled(group, reopen);
          await select(group, null);
        }
      }
    }
  });
}

test('rapid reversals and changing destinations preserve one moving panel', async ({ page }) => {
  await openPanels(page);
  const group = page.locator('.side-panels');
  const frames = await group.evaluate(async group => {
    const frames: { count: number; error: number; selected: string | null; x: number }[] = [];
    const steps = ['plate', 'plate', 'details', 'plate', 'details', 'details', 'plate', 'details'];
    for (let index = 0; index < 44; index++) {
      if (index < steps.length * 2 && index % 2 === 0)
        group.querySelector<HTMLButtonElement>(`[data-edge-tab="${steps[index / 2]}"] button`)!.click();
      await new Promise(requestAnimationFrame);
      const visible = [...group.querySelectorAll('.edge-panel-body')].filter(body => getComputedStyle(body).visibility === 'visible');
      const handle = group.querySelector('.edge-panel-tabs > .is-presented button')?.getBoundingClientRect();
      frames.push({ count: visible.length, error: visible.length ? Math.abs(handle!.right - visible[0]!.getBoundingClientRect().left) : 0,
        selected: group.getAttribute('data-active'), x: handle?.x ?? group.getBoundingClientRect().right });
    }
    return frames;
  });
  expect(frames.every(frame => frame.count <= 1 && frame.error < 1)).toBe(true);
  expect(new Set(frames.map(frame => Math.round(frame.x))).size).toBeGreaterThan(8);
  await settled(group, 'details');
  await select(page.locator('.map-edge-tools .edge-panels'), 'charts');
  await expect(page.locator('.map-edge-tools .edge-panel.is-open')).toHaveCount(1);
  await expect(group.locator('.edge-panel.is-open')).toHaveCount(1);
});

test('resizing during motion keeps the panel tab attached and reduced motion still completes switches', async ({ page }) => {
  await openPanels(page);
  const group = page.locator('.side-panels');
  // Hold the slide long enough to resize the actual viewport in its middle.
  await page.addStyleTag({ content: '.edge-panels { transition-duration: 600ms; }' });
  await tab(group, 'details').evaluate(button => (button as HTMLElement).click());
  await page.setViewportSize({ width: 393, height: 852 });
  await expect.poll(() => group.evaluate(group => {
    const body = group.querySelector('.is-presented > .edge-panel-body')!;
    return Math.abs(group.querySelector('.edge-panel-tabs > .is-presented button')!.getBoundingClientRect().right - body.getBoundingClientRect().left);
  })).toBeLessThan(1);
  await settled(group, 'details');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const name of ['plate', 'details', 'plate'] as const) {
    await openSidePanel(page, name);
    await settled(group, name);
  }
  await tab(group, 'plate').click();
  await settled(group, null);
});

test('replacing details keeps their own width and moves the tabs to the new edge', async ({ page }) => {
  await page.goto('/');
  const group = page.locator('.side-panels');
  let tabTop: number | undefined;
  for (const [ident, width] of [['KSBA', 390], ['CMA', 330], ['KSMO', 390]] as const) {
    await page.getByLabel('Search FAA navigation data').fill(ident);
    await page.locator('.search-results button').filter({ hasText: ident }).click();
    await settled(group, 'details');
    const body = (await page.locator('.feature-card').boundingBox())!;
    expect(body.width).toBe(width);
    const handle = (await tab(group, 'details').boundingBox())!;
    tabTop ??= handle.y;
    expect(handle.y, 'changing panel height preserves the tab slot').toBe(tabTop);
    expect(Math.abs(handle.x + handle.width - body.x)).toBeLessThan(1);
  }
});

test('a restored airport slides in after delayed workspace data loads', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, 'serviceWorker');
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
      type: 'Feature', geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
      properties: { kind: 'airport', icaoId: 'KSBA', faaId: 'SBA', name: 'TEST AIRPORT' },
    } }));
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/chart-data/**', async route => { await gate; await route.continue(); });
  await page.goto('/');
  const group = page.locator('.side-panels');
  await expect(group.locator('.feature-card')).toHaveCount(0);
  const sampled = page.evaluate(async () => {
    const frames: { x: number; error: number }[] = [];
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      const group = document.querySelector('.side-panels');
      const body = group?.querySelector('.feature-card')?.getBoundingClientRect();
      if (body) frames.push({ x: body.x, error: Math.abs(body.left - group!.querySelector('[data-edge-tab="details"] button')!.getBoundingClientRect().right) });
    } while (performance.now() - start < 1_200);
    return frames;
  });
  release();
  const frames = await sampled;
  expect(new Set(frames.map(frame => Math.round(frame.x))).size).toBeGreaterThan(2);
  expect(Math.max(...frames.map(frame => frame.error))).toBeLessThan(1);
  await settled(group, 'details');
});

test('reopening cancels a close in progress and a reload commits a requested close', async ({ page }) => {
  await openPanels(page);
  const group = page.locator('.side-panels');
  await page.addStyleTag({ content: '.edge-panels { transition-duration: 600ms; }' });
  await page.getByRole('button', { name: 'Close plate', exact: true }).evaluate(async button => {
    (button as HTMLElement).click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    document.querySelector<HTMLButtonElement>('[data-edge-tab="plate"] button')!.click();
  });
  await settled(group, 'plate');
  await expect(page.locator('.procedure-panel')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close plate', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Aviation chart map')).toBeVisible();
  await expect(page.locator('.procedure-panel')).toHaveCount(0);
  await settled(page.locator('.side-panels'), null);
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await settled(page.locator('.side-panels'), 'details');
});
