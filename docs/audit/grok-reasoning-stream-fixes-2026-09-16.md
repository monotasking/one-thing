# Grok 思考配置与流式修复

已实现可扩展的思考配置，修复工具卡排序兜底和 Responses 流解析缺口。没有重启正在运行的桌面，没有发送真实付费模型请求，没有修改用户现有模型选择。主进程相关修改需在下次正常重启或重新构建后生效。

## 如何使用

1. 在输入框的模型选择器中选择 Grok，再选择思考等级。
2. 要调整某个模型支持的等级、默认等级或显示名称：打开 **设置 → 模型服务 → 对应模型行的配置按钮 → 自定义思考配置**，修改后点“保存思考配置”。
3. 高级参数映射可选择“继承服务商配置”“使用内置适配”或“自定义映射”。没有特殊 API 需求时保留继承即可。
4. “恢复默认思考配置”删除模型覆盖，重新使用 provider 默认和内置规则。上下文及其他能力单独保存；不会因清除思考配置而丢失。

模型配置支持全部 provider；内置适配按各模型的真实能力提供默认值。手填模型也会投影思考配置，并保持可重命名、移除。

## Grok 默认规则

| 模型 | 可选等级 | 关闭与旧设置的处理 |
| --- | --- | --- |
| Grok 4.6 | low / medium / high / xhigh | 不可关闭；旧“关”按 low 发送并显示为低 |
| Grok 4.5 | low / medium / high | 不可关闭；旧“关”按 low 发送并显示为低 |
| Grok 4.3 | low / medium / high，默认 low | 可关闭，关闭发送 none |
| 旧 Grok 4、普通 4.20 等无已确认 effort 能力的模型 | 不显示无效档位 | 保留原生思考行为，不发送未经确认的 effort |

未配置的 4.6/4.5 默认仍为 high。配置更改不会把所有模型静默改成 low。旧档位不再被支持时，界面和请求共用同一等级映射函数。

依据：[xAI 思考能力文档](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[Grok 4.3 模型文档](https://docs.x.ai/developers/models/grok-4.3)。4.3 文档对 xhigh 的说明仍有不一致，本次保守使用明确列出的 none / low / medium / high。

## 可扩展配置结构

默认值位于 provider 配置的 `providerOptions.reasoningProfile`；逐模型覆盖位于 `modelCapabilitiesByModel[modelId].reasoningProfile`。优先级为 **模型覆盖 → provider 默认 → 内置规则**。

可配置字段：

- `efforts`、`defaultEffort`：可选档位与默认档。
- `toggleable`、`defaultOn`、`disabledEffort`：开关能力、默认状态、不可关闭模型兼容旧“关”设置所用的档位。
- `effortLabels`：六个通用档位的自定义显示名称。
- `custom`：API 字段路径、等级值映射、开启/关闭时的附加请求体；`null` 明确恢复内置编码，缺席则继承 provider。
- `wire`：高级配置使用的编码方式；显式指定不支持的编码会报错，不静默套用别的协议。

以下是一个配置结构示例，放在目标 provider 的配置对象内。字段和值必须符合目标服务商 API；Grok 自身已有内置适配，通常无需填写 custom。

```json
{
  "providerOptions": {
    "reasoningProfile": {
      "efforts": ["low", "medium", "high"],
      "defaultEffort": "medium",
      "toggleable": false,
      "defaultOn": true,
      "effortLabels": { "low": "快速", "high": "深入" }
    }
  },
  "modelCapabilitiesByModel": {
    "example-model": {
      "reasoningProfile": {
        "efforts": ["low", "high"],
        "defaultEffort": "low",
        "custom": {
          "effortPath": "reasoning.effort",
          "effortValues": { "low": "low", "high": "high" }
        }
      }
    }
  }
}
```

配置在保存前验证。无效路径、非法 JSON 值、危险对象键、无映射的 custom 编码会被拒绝。映射对象按请求复制，避免跨轮修改。自定义编码仍保留 provider 的原生思考解析与加密内容回传。

## 交接问题逐项结果

| 问题 | 本次结果 | 剩余边界 |
| --- | --- | --- |
| 工具卡流式掉到正文下方 | 实时补正文读取账本段的真实轮次；历史兜底区分后续正文与取消/中断工具。回归覆盖多轮工具、缺水位及流结束前后顺序 | 原现场水位为什么缺失仍未证实；新增缺水位、缺身份章和兜底计数 |
| 思考不实时 | 增加 `response.reasoning_text.delta/done`，修复摘要有部分 delta 时 done 尾巴被丢弃；按 item/part 去重 | 官方支持增量事件，不能笼统归因于上游；若上游只发整块，客户端无法提前获得内容 |
| 工具参数整块到达 | 保留真实到达节奏；测试保证分块传输解析和及时产出 | xAI 官方说明函数参数整块到达，不虚构逐字流式 |
| “思考关”却实际 high | 4.6/4.5 旧关闭设置明确 low；UI 同步有效值，不再显示关 | 旧设置不被批量改写 |
| parallel_tool_calls 为 false | 核对调度器 barrier 与并行测试，本次保留设置 | 尚未做真实 Grok 并行验证，不将调度器单测等同于实机结论 |
| 说要搜索然后停止 | 未识别 SSE 事件与 output item 进入安全统计日志，方便下次识别返回类型 | web_search 名称冲突仍未证实；未改工具名、未启用原生付费搜索 |

安全流诊断只记录事件类型、计数、文本长度和首次到达耗时，不记录用户正文、思考正文、密钥或工具参数。详细 wire 说明见 [Grok wire 修复报告](./grok-wire-fixes-2026-09-16.md)。

函数参数和并行默认行为依据：[xAI function calling](https://docs.x.ai/developers/tools/function-calling)。

## 验证

- 前端 12 个相关文件合跑 **518 项通过**；随后增加 current-only 手填模型改名测试，配置与表单两组 **74 项通过**（包含该新增用例）。
- 后端最终 12 个相关文件合跑 **275 项通过**，包含四种协议请求快照、配置到实际请求体、模型投影、自定义配置及 SSE 流测试。
- 随后补充“原生默认关闭模型被配置为不可关闭”的真实请求回归，思考配置两组 **31 项通过**；缺省与旧关闭设置均和界面一致。
- 前后端类型检查通过；本次前端变更文件 ESLint 通过。
- 浏览器隔离预览检查：实际配置浮层、展开滚动、等级名称输入和默认等级控件可见；临时预览页面已删除，未写入真实用户配置。
- 没有执行真实 Grok 请求，原服务端停止现象与本次修改的实机效果仍需下次实际使用验证。

## 主要实现位置

- 配置和模型规则：`packages/onething-runtime/src/providers/model-capability.ts`、`packages/shared/ipc/providers.ts`。
- 参数编码：`packages/onething-runtime/src/agent-loop/providers/thinking/custom-reasoning.ts`、`grok-responses-reasoning.ts`。
- 流式解析：`packages/onething-runtime/src/agent-loop/providers/wires/openai-responses-wire.ts`。
- 工具卡顺序：`apps/desktop-react/src/data/missing-assistant-text.ts`、`chat-materialize.ts`、`chat-source.ts`。
- 配置面板：`apps/desktop-react/src/providers/components/ReasoningProfileEditor.tsx`；实时读数：`apps/desktop-react/src/data/models-source.ts`。
