// @ts-check
/**
 * desktop-react 自己的 lint 配置(flat config)。
 *
 * **本地化**是刻意的:仓根那套 ESLint 服务的是 Vue + 一堆历史包袱,
 * `--max-warnings 200` 那种带存量的口径。这个应用是新的,从零开始,
 * 所以它自己一份、**零警告**、规则更严 —— 别把新树拉回旧基线。
 *
 * 四组规则,各解决一类问题:
 *  · typescript-eslint 的 recommended —— 类型层面的常见错(不开 type-checked 那档:
 *    它要为每个文件跑一遍类型推断,把 lint 从 3 秒拖到 30 秒;类型正确性归 `tsc --noEmit`,
 *    那道门本来就在 verify 里跑,重复一遍不划算);
 *  · react-hooks —— **rules-of-hooks 与 exhaustive-deps 都是 error**。后者尤其:
 *    依赖数组漏项是「改了状态但界面不跟着变」这类幽灵 bug 的头号产地;
 *  · jsx-a11y recommended —— 键盘可达、语义角色、label 绑定;
 *  · no-console —— 说话一律走 `services/log.ts` 的 getLogger。
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default tseslint.config(
  {
    // 产物与依赖不进 lint。dist-electron 是 esbuild 打出来的 .cjs。
    ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'src/assets/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // 计划里点名的两条,都是 error(recommended 里 exhaustive-deps 只是 warn)。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // 裸 console 一律禁。唯一出口是 services/log.ts 里那一处带 disable 注释的镜像。
      'no-console': 'error',
      // `_` 前缀 = 「知道它没用,留着是为了签名对齐」。这是个约定,不是漏网。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // main / preload 跑在 node 里,不是浏览器。
    files: ['electron/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // 测试文件:vitest 的全局(globals: true)+ 断言里常用的 any。
    files: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}', 'src/test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // 测试里 `as any` 造畸形输入是**正当手段**(要验的正是「给了坏东西会怎样」)。
      '@typescript-eslint/no-explicit-any': 'off',
      // 空函数就是最常见的 stub。
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // 门脚本与构建脚本:node 环境,且**它们的产品就是打印出来的那些行**——
    // console 在这里不是随手调试,是输出面(与仓根 CLAUDE.md 的 log:gate 白名单同一条口径)。
    //
    // 也带上 browser globals:门脚本里 `page.evaluate(() => document.querySelector(…))`
    // 那些闭包是**发进页面里执行**的,`document` / `window` / `getComputedStyle`
    // 在那一侧真实存在。一个文件两种运行环境,ESLint 的 globals 是文件级的,
    // 所以这里取并集 —— 代价是脚本的 node 半边也认得 document,可接受。
    files: ['scripts/**/*.mjs', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
)
