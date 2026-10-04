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
  // 区 ① 后端的功能目录 + shared。从 core 并进来的那些文件通过注入 / `getCoreLogger` 拿 logger,
  // 其余用 `@onething/backend/logging` 的 `getLogger(ns)`;`packages/shared`
  // 是纯契约,本来就一条 console 都没有。测试里的 console 不算。(core 目录于 2026-10-03 并进 runtime;
  // 2026-10-04 去掉 `runtime/` 这一层,功能目录直接住在包根下 —— 范围照旧只是功能目录,所以把包根的散文件、
  // `http-server/` 与包级 `__tests__/` 排除在外,与搬家前扫 `runtime/**` 的文件集合相同。)
  {
    files: [
      'packages/shared/**/*.ts',
      'packages/backend/**/*.ts',
    ],
    ignores: [
      'packages/backend/*.ts',
      'packages/backend/http-server/**',
      'packages/backend/node_modules/**',
      'packages/shared/**/__tests__/**',
      'packages/shared/**/*.test.ts',
      'packages/backend/**/__tests__/**',
      'packages/backend/**/*.test.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },

  // 区 ② 装配层 + server 壳。产品代码只见 `@onething/app/logging` 的 `getLogger(ns)`;
  // 白名单只有 `apps/backend-server/src/main.ts` 的四条**启动期**行(`configureLogging()`
  // 在 runtime 装配之后才接线,那之前必须直写 stderr),它们逐条带
  // `eslint-disable-next-line no-console` + 理由;测试里的 console 不算。
  // (从前这里还列着 `runtime/app/**` 的两条 glob,那个目录早已不存在、一只文件都匹配不到;
  // 2026-10-04 去掉 `runtime/` 这一层时一并删去。)
  {
    files: [
      'apps/backend-server/src/**/*.ts',
    ],
    ignores: [
      'apps/backend-server/src/**/__tests__/**',
      'apps/backend-server/src/**/*.test.ts',
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
