import { defineConfig } from '@rslib/core';

export default defineConfig({
	lib: [
		{
			format: 'esm',
			bundle: false,
			dts: {
				bundle: false,
			},
		},
	],
	source: {
		entry: {
			index: ['./src/**/*.ts', '!./src/**/*.test.ts', '!./src/**/*.spec.ts', '!./src/__tests__/**'],
		},
		tsconfigPath: './tsconfig.build.json',
	},
	output: {
		target: 'node',
		distPath: {
			root: './dist',
		},
		sourceMap: {
			js: 'source-map',
		},
	},
});
