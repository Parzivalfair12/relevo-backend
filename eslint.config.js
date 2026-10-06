import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'backups/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Los documentos de Mongo «lean» y los DTO de las rutas se tipan de forma práctica; no se prohíbe `any`
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-namespace': 'off', // la declaración de Express.Request en middleware/index.ts lo necesita
      'no-console': ['error', { allow: ['log', 'error'] }], // en la API se usa el registro (pino); los scripts sí imprimen
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  }
);
