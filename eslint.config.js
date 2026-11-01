import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({ ignores: ['dist/'] }, tseslint.configs.recommended, {
  rules: {
    // Allows `const { KEY: _omitted, ...rest } = obj` to drop a key.
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
  },
});
