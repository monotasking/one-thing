/**
 * 智谱 GLM 的自述(`docs/design/architecture-direction-2026-10.md` §4 P1)。
 *
 * 这一家的**数据**全在这里:显示名、方言、目录、档位与地址、读密钥的环境变量、
 * 模型认亲、错误码说明、型号规则。通用代码只读这些字段,不写「zhipu」。
 * 行为(方言、思考参数、运行时工厂)在同目录的 `runtime.ts`。
 *
 * 纯模块:壳也 import(经 `vendors/manifests.ts`),不许碰 node / agent-loop。
 */
import type { DialSpec } from '../../dials.js'
import type { ProviderManifest } from '../../provider-manifest.js'
import {
  ONETHING_ZHIPU_CODING_PLAN_BASE_URL,
  ONETHING_ZHIPU_STANDARD_BASE_URL,
  pickOnethingZhipuOptions,
  type OnethingZhipuBaseUrlConfig,
  resolveOnethingZhipuBaseUrl,
} from './zhipu-endpoint.js'

export const ZHIPU_DIALS: DialSpec = {
  apiModeKey: 'zhipuApiMode',
  apiMode: {
    label: 'API mode',
    ariaLabel: 'Zhipu API mode',
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'coding-plan', label: 'Coding Plan' },
    ],
    // 智谱没有归一函数(它只有两档、没有地区),判据与生产那张表逐字相同。
    normalize: (value) => (value === 'coding-plan' ? 'coding-plan' : 'standard'),
  },
  // 智谱没有地区,也没有风险说明 —— 生产那张表就是这样,这里不替它补一句。
  baseUrlOf: (apiMode) =>
    apiMode === 'coding-plan' ? ONETHING_ZHIPU_CODING_PLAN_BASE_URL : ONETHING_ZHIPU_STANDARD_BASE_URL,
}

/** 智谱开放平台的业务错误码(官方文档「错误码」一节)。 */
const ZHIPU_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '1000': '身份验证失败。请求已带认证信息，但 token 未通过智谱校验；普通 API Key 请使用 Standard 模式，Coding Plan Key 请使用 Coding Plan 模式，并检查设置中是否残留旧 key。',
  '1001': 'Header 中未收到 Authentication 参数。请确认请求使用 Authorization: Bearer <API Key>。',
  '1003': 'Authentication Token 已过期。请在智谱控制台重新生成或获取 API Key。',
  '1005': '账号已开启二次认证保护，需要完成二次认证登录。',
  '1113': '账户已欠费，请充值后重试。',
  '1210': 'API 调用参数有误，请对照智谱接口文档检查请求体。',
  '1211': '模型不存在，请检查模型代码是否正确。',
  '1220': '当前账号或 API Key 无权访问该 API。',
  '1261': 'Prompt 超长，请缩短上下文或开启压缩。',
  '1301': '输入或生成内容可能包含不安全或敏感内容。',
  '1302': '账户已达到速率限制，请降低请求频率。',
  '1305': '模型当前访问量过大，请稍后重试。',
  '1309': 'GLM Coding Plan 套餐已到期，请续订后重试。',
  '1311': '当前订阅套餐暂未开放该模型权限。',
  '1315': '该 API Key 仅限企业编程套餐场景使用，请切换到匹配的 API 模式或更换对应产品类型的 API Key。',
}

export const ZHIPU_MANIFEST: ProviderManifest = {
  id: 'zhipu',
  origin: 'builtin',
  name: '智谱 GLM',
  description: 'providers.desc.zhipu',
  icon: 'zhipu',
  dialect: 'zhipu',
  auth: { kind: 'apiKey' },
  models: { kind: 'models.dev', key: 'zhipuai' },
  billing: 'api',
  dials: ZHIPU_DIALS,
  modelRules: 'zhipu',
  // 用户能在思考覆盖(`reasoningProfile.wire`)里点名的线型(见 `ProviderManifest.reasoningWires`)。
  reasoningWires: ['zhipu-thinking'],
  defaultBaseUrl: ONETHING_ZHIPU_STANDARD_BASE_URL,
  supportsCustomBaseUrl: true,
  defaultModel: 'glm-5.2',
  envVars: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'],
  modelIdentity: { brands: ['z-ai', 'zai', 'zhipu', 'zhipuai', 'thudm'], keys: ['zhipuai', 'zai'] },
  catalogAliases: ['zhipuai'],
  errorDescriptions: ZHIPU_ERROR_DESCRIPTIONS,
  endpoint: {
    pickOptions: pickOnethingZhipuOptions,
    resolveBaseUrl: (config) => resolveOnethingZhipuBaseUrl(config as OnethingZhipuBaseUrlConfig | undefined),
    entryFields: { apiMode: 'zhipuApiMode' },
    // 地址是从档位派生出来的:只抹档位不抹地址,全局档位会顺着地址原路漏回来。
    ownsBaseUrl: true,
  },
  modelRuleTable: [
    {
      test: /glm-(?:4\.[5-9]|[5-9])/,
      caps: { reasoning: true },
      profile: {
        toggleable: true,
        defaultOn: true,
        efforts: [],
        defaultEffort: 'high',
        wire: 'zhipu-thinking',
      },
    },
    // 智谱全系不支持强制调用:官方文档写明 `tool_choice` 目前仅支持 `auto`
    // (#5b)。挂在 catch-all 上就够 —— 上面那条 reasoning 行对
    // `forcedToolUse` 不表态,而 `fromRules` 是**按能力**各取「第一条给出布尔
    // 值的行」,所以 reasoning 的顺序语义一点没动。
    { test: /(?:)/, caps: { reasoning: false, forcedToolUse: false } },
  ],
  // 出厂设置里的那一条,逐字照搬自 P3 之前 `@shared/defaults/settings.ts` 的默认表(见 `ProviderSeed`)。
  seed: {
    apiKey: '',
    zhipuApiMode: 'standard',
    model: 'glm-5.2',
    selectedModels: [],
    enabled: false,
  },
}
