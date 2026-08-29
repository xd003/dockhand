import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173';

export default defineConfig({
	testDir: './integration/e2e',
	testMatch: '**/*.spec.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'line',
	use: {
		baseURL,
		storageState: process.env.PLAYWRIGHT_STORAGE_STATE || undefined,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{ name: 'phone-320', use: { viewport: { width: 320, height: 568 } } },
		{ name: 'phone-375', use: { viewport: { width: 375, height: 667 } } },
		{ name: 'phone-390', use: { viewport: { width: 390, height: 844 } } },
		{ name: 'phone-landscape', use: { ...devices['iPhone 13 landscape'] } },
		{ name: 'boundary-640', use: { viewport: { width: 640, height: 800 } } },
		{ name: 'boundary-768', use: { viewport: { width: 768, height: 800 } } },
		{ name: 'tablet', use: { viewport: { width: 820, height: 1180 } } },
		{ name: 'laptop', use: { viewport: { width: 1024, height: 768 } } },
		{ name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
		{ name: 'wide-desktop', use: { viewport: { width: 1920, height: 1080 } } }
	],
	webServer: process.env.PLAYWRIGHT_BASE_URL
		? undefined
		: {
			command: 'npm run dev -- --host 127.0.0.1 --port 4173',
			url: baseURL,
			reuseExistingServer: true,
			timeout: 120_000
		}
});
