import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default [
  // Global ignores (must be a standalone config object)
  {
    ignores: ['dist/**', 'out/**', 'release/**', 'node_modules/**', '**/dist-electron/**', 'apps/desktop-react/dist/**', '.claude/**', 'public/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,


  // General settings
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  // Relax rules that are too noisy for this codebase
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-case-declarations': 'off',
    },
  },

  // ── L4 日志迁移:迁完的区开 no-console(docs/design/logging-system-2026-08.md §8)
  // 区 ① core + runtime 产品层。core 通过注入 / `getCoreLogger` 拿 logger,
  // 产品层用 `@onething/runtime/logging` 的 `getLogger(ns)`;`packages/shared`
  // 是纯契约,本来就一条 console 都没有。测试里的 console 不算。
  {
    files: [
      'packages/core/**/*.ts',
      'packages/shared/**/*.ts',
      'packages/onething-runtime/src/**/*.ts',
    ],
    ignores: [
      // 区 ② 的装配层自己开(文件不相交,§8.3)。
      'packages/onething-runtime/src/app/**',
      'packages/core/**/__tests__/**',
      'packages/core/**/*.test.ts',
      'packages/shared/**/__tests__/**',
      'packages/shared/**/*.test.ts',
      'packages/onething-runtime/src/**/__tests__/**',
      'packages/onething-runtime/src/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },

  // 区 ② 装配层 + server 壳。产品代码只见 `@onething/app/logging` 的 `getLogger(ns)`;
  // 白名单只有 `apps/server/src/main.ts` 的四条**启动期**行(`configureLogging()`
  // 在 runtime 装配之后才接线,那之前必须直写 stderr),它们逐条带
  // `eslint-disable-next-line no-console` + 理由;测试里的 console 不算。
  {
    files: [
      'packages/onething-runtime/src/app/**/*.ts',
      'apps/server/src/**/*.ts',
    ],
    ignores: [
      'packages/onething-runtime/src/app/**/__tests__/**',
      'packages/onething-runtime/src/app/**/*.test.ts',
      'apps/server/src/**/__tests__/**',
      'apps/server/src/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },

  // 区 ③a Electron 宿主。产品代码只见 `getLogger(ns)`;测试里的 console 不算。

  // 区 ③a′ CLI(2026-09-03 从 apps/electron/src/main/cli 搬到 apps/cli/src)。
  // 排障日志走 `getLogger(ns)`;**给人/管道看的**产品输出走 `stdout.ts` ——
  // 它自己就是那个口,不能禁;测试里的 console 不算。
  {
    files: ['apps/cli/src/**/*.ts'],
    ignores: [
      'apps/cli/src/stdout.ts',
      'apps/cli/src/**/__tests__/**',
      'apps/cli/src/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },

]
