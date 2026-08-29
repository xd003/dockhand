import { expect, test } from '@playwright/test';

const routes = ['/', '/containers', '/logs', '/stacks', '/images', '/volumes', '/networks', '/settings'];

test.beforeEach(() => {
	test.skip(!process.env.PLAYWRIGHT_STORAGE_STATE, 'Set PLAYWRIGHT_STORAGE_STATE to an authenticated Playwright state file.');
});

for (const route of routes) {
	test(`responsive smoke: ${route}`, async ({ page }) => {
		await page.goto(route, { waitUntil: 'domcontentloaded' });
		await expect(page.locator('body')).toBeVisible();
		if (route === '/settings') {
			await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
			await expect(page.getByText('Stack operation logs', { exact: true })).toBeVisible();
		}

		const overflow = await page.evaluate(() => ({
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: document.documentElement.clientWidth,
			containers: Array.from(document.querySelectorAll('.overflow-auto, .overflow-x-auto'))
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0;
				})
				.length
		}));

		expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
		expect(overflow.containers).toBeGreaterThanOrEqual(0);

		if ((page.viewportSize()?.width ?? 0) >= 768) {
			await expect(page.locator('.mobile-grid-toolbar')).toBeHidden();
			await expect(page.locator('.mobile-grid-label')).toBeHidden();
			await expect(page.locator('.mobile-card-toggle-cell')).toBeHidden();
			await expect(page.locator('.data-grid-scroll-hint')).toBeHidden();
		}

		await page.screenshot({ path: test.info().outputPath(`${route === '/' ? 'dashboard' : route.slice(1)}.png`), fullPage: true });
	});
}

test('keyboard smoke: settings tabs and dialog focus', async ({ page }) => {
	await page.goto('/settings', { waitUntil: 'domcontentloaded' });
	await page.keyboard.press('Tab');
	await expect(page.locator(':focus')).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(page.locator(':focus')).toBeVisible();
});
