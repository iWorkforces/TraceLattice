import { defineConfig } from 'vitest/config';

const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
	test: {
		globals: true,
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
		teardownTimeout: TEST_TIMEOUT_MS,
		exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.nuxt/**'],
		include: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/*.eval.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: ['**/*.test.ts', '**/types.ts', 'dist/**', 'node_modules/**', 'src/__tests__/**'],
			thresholds: {
				branches: 90,
				functions: 60,
				lines: 65,
				statements: 65,
			},
		},
	},
});
