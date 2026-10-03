/**
 * 出厂设置冻结测试的输入(服务商自述试点 P3:默认 provider 配置从 `@shared/defaults` 搬进各家
 * manifest 的 `seed`)。两份代表性的 `mergeWithDefaults` 输入 + 一份空输入。
 *
 * - `unmigrated`:C2 迁移**之前**的盘上形状 —— `ai` 里还躺着 `provider` / `providers` /
 *   `customProviders`,默认表要并进来;用户改过的几格(某家的 key、档位格、一家不在默认表里的
 *   provider、历史脏键 `localAddress`)都要原样留下或按旧规矩剥掉。
 * - `migrated`:迁移**之后**的全局段 —— 只剩温度与目录缓存,默认表不许并回来。
 * - `empty`:什么都没有。
 */
export const SETTINGS_DEFAULTS_FREEZE_INPUTS: Record<string, Record<string, unknown>> = {
  unmigrated: {
    ai: {
      provider: 'deepseek',
      temperature: 0.4,
      providers: {
        openai: { apiKey: 'sk-test', model: 'gpt-4.1', selectedModels: ['gpt-4.1'], enabled: true },
        zhipu: {
          apiKey: '',
          zhipuApiMode: 'coding-plan',
          model: 'glm-5.2',
          selectedModels: [],
          enabled: true,
          localAddress: 'http://127.0.0.1:1',
        },
        qwen: { apiKey: 'sk-q', qwenRegion: 'intl', model: 'qwen3.7-plus', selectedModels: ['qwen3.7-plus'] },
        'vendor-not-in-defaults': { apiKey: 'x', model: 'm', selectedModels: ['m'], enabled: true },
      },
      customProviders: [{ id: 'custom-1', name: 'C', apiType: 'openai', baseUrl: 'http://x', apiKey: 'k', model: 'm', selectedModels: [], localAddress: 'y' }],
      modelCatalog: { openai: { fetchedAt: 1 } },
    },
  },
  migrated: {
    ai: { temperature: 0.3, modelCatalog: { deepseek: { fetchedAt: 2 } } },
    storage: { spaceProviderSettingsMigratedAt: 1_700_000_000_000 },
  },
  empty: {},
}
