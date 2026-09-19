import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.node,
				process: 'readonly',
				console: 'readonly',
				Buffer: 'readonly',
				__dirname: 'readonly',
				__filename: 'readonly',
			},
			ecmaVersion: 'latest',
			sourceType: 'module',
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
			'no-restricted-syntax': [
				'error',
				{
					selector: "TSAsExpression[typeAnnotation.typeName.name='SessionId']",
					message: 'Use asSessionId() from contracts/ids.ts instead of raw as SessionId cast.',
				},
				{
					selector: 'ExportAllDeclaration',
					message: 'Do not re-export. Import the canonical module instead.',
				},
				{
					selector: 'ExportNamedDeclaration[source]',
					message: 'Do not re-export. Import the canonical module, then export local bindings.',
				},
			],
		},
	},
	{
		ignores: ['dist/**', 'node_modules/**', '*.config.js', 'coverage/**'],
	},
];
