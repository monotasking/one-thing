import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  // Global ignores (must be a standalone config object)
  {
    ignores: ['dist/**', 'out/**', 'release/**', 'node_modules/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // Vue files: use typescript-eslint parser inside <script lang="ts">
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },

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
    files: ['**/*.ts', '**/*.vue'],
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

  // 区 ③a Electron 宿主。产品代码只见 `getLogger(ns)`;CLI 的**用户输出**走
  // `main/cli/stdout.ts`(它自己就是那个口,不能禁);测试里的 console 不算。
  {
    files: ['apps/electron/src/**/*.ts'],
    ignores: [
      'apps/electron/src/main/cli/stdout.ts',
      'apps/electron/src/**/__tests__/**',
      'apps/electron/src/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },

  // 区 ③b renderer。产品代码只见 `@/services/log` 的 `getLogger(ns)`;
  // hub 自己的 console 回显走动态成员访问(`target[method]`),不是字面量,
  // 所以不需要白名单;测试里的 console 不算。
  {
    files: ['packages/renderer/**/*.ts', 'packages/renderer/**/*.vue'],
    ignores: [
      'packages/renderer/**/__tests__/**',
      'packages/renderer/**/*.test.ts',
      'packages/renderer/**/*.spec.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
]
