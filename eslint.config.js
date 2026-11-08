import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

/** jsx-a11y 推荐规则统一降为 warn：先让问题可见，不阻断 CI（存量清理前） */
function warnOnly(rules) {
  return Object.fromEntries(
    Object.entries(rules).map(([name, value]) => {
      const severity = Array.isArray(value) ? value[0] : value;
      return severity === 0 || severity === 'off' ? [name, value] : [name, 'warn'];
    })
  );
}

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', '.perf', 'coverage', 'docs/screenshots'] },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      ...warnOnly(jsxA11y.flatConfigs.recommended.rules),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      // 存量只有 1 处 Table<any, any>（sync 批量读写），先 warn 暴露，清理后转 error
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
);