#!/usr/bin/env node
/**
 * 会话消息写/读路径检查器 —— docs/design/session-commands-p0-2026-08.md §4。
 *
 * **用 TypeScript 编译器 API 做类型感知**,不是正则(上游 §7.2 M8 的原话:正则
 * 会命中 `message-queue.ts` 的 `this.messages`、`room-rules.ts` 的
 * `effects.messages`、provider 的 `body.messages` —— 那些跟会话消息毫无关系)。
 * 判据落在类型上:
 *   - 会话形状 = 有 `messages` 属性、且元素类型同时有 `id` 与 `role`;
 *   - 消息形状 = 有 `id` 与 `role`;
 *   - step 形状 = 有 `id` 与 `title` 且没有 `role`;
 *   - toolCall 形状 = 有 `status` 且带 `toolName`/`arguments`/`requiresConfirmation` 之一。
 * 泛型参数(`TMessage extends …`)按 apparent type 解析,所以泛化的 store-helpers
 * 也照样命中。
 *
 * 三条规则:
 *   A `session.messages` 的属性访问 —— 只许白名单文件;
 *   B 对 ChatMessage / Step / ToolCall 的属性赋值、`delete`、`Object.assign(x,…)`、
 *     `x.steps|contentParts|toolCalls.push/splice` —— 只许 `core/session/commands.ts`;
 *   C `<session>.messages = …` 整体赋值 —— 白名单内也不许(命令面 COW 返回新数组)。
 *
 * 输出:每行 `[session] failed: <file>:<line> <rule>`,末尾一行 `[session] complete:`。
 * 棘轮见 `scripts/session-gate.mjs`;全表 `bun run session:check`。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 规则 A 的白名单:允许持有 `session.messages` 的地方。
 * 每一条都要有一句能站住的理由 —— 白名单里的文件此后不受棘轮监督。
 */
const RULE_A_ALLOWED = new Set([
  // 纯 reducer:12 命令唯一的实现处
  'packages/core/session/commands.ts',
  // 装配层写面 / 读面:设计文档 §1 的两扇门
  'packages/backend/session/commands.ts',
  'packages/backend/session/reads.ts',
  // 存储形状:脱水看的是"盘上长什么样",不是会话语义
  //
  // `storage-driver.ts` 曾经也在这里,理由是它的**消息写半边**(全量重写 / 后缀
  // 重写要逐条编码 `session.messages`)。S3w-3 批 6b 把那半边删了(§15.22),
  // 剩下的只有 `buildMeta` 摘掉 messages、以及 legacy 首触迁移里数一下条数 ——
  // 都落在驱动自己那个 `SessionLike { messages?: unknown[] }` 上,元素类型是
  // `unknown`,本来就不构成规则 A 说的"一条会话的消息日志"。实测拿掉这条 0 命中,
  // 所以收掉:哪天有人把驱动重新类型化到真的 `ChatMessage`,这道闸该响。
  'packages/onething-runtime/src/sessions/session-dehydrate.ts',
  // 仓库层 = 读门面的底座(P0.4):四处都是"jsonl/sqlite 取不到时回落到内存
  // 权威副本"的取数原语(getSessionMessages / 分页 / marker / 缓存快照),
  // 下面没有别的层可以再问一次,不是业务读。
  'packages/onething-runtime/src/sessions/session-repository.ts',
])

/**
 * 规则 B 的白名单:唯一允许改消息/step/toolCall 字段的地方。
 *
 * **F4-c c4-b 又复核了一次,理由再换、名单仍旧没换**(§16.25)。
 *
 * c4(§16.24 第五节)停手的理由是三条**写手对象独有依赖**:收尾链读它的
 * `steps[]` 与 `data-steps` 渲染锚点、abort 按它的 `isStreaming` 寻址、truncate
 * 按它的 `usage` 结算扣减。**c4-b 把这三条全拆了**:
 *
 *   ① 锚点由推送侧从折叠产物**现算**(`@onething/core/session/render-anchors`,
 *      renderer 加载路径与主进程 settle 推送同一份实现),写手不再是保管人;
 *   ② abort 按**活 run 登记簿**(`currentSessionRun`)寻址,`isStreaming` 回到
 *      "由 run 开闭推导的结论"这一个语义;
 *   ③ truncate 的用量结算由命令面从**折叠产物**算好递进归约器。
 *
 * `getLiveRunWriterMessage` 因此已删除 —— **"活 run 写手视图"这个概念退役了**。
 *
 * 那为什么名单还是没换?因为剩下的最后一格不是"依赖",是**身份**:内存 store
 * 上那份消息数组今天仍然由这个 reducer 维护,而"store = 折叠物化"要的是让**读**
 * 侧改从物化取(§16.25 第五节:唯一剩下的那次切换,它自带一次性能/时机裁定)。
 * 在那次切换落地之前,这个 reducer 仍然是消息字段唯一的赋值处。
 *
 * 所以名单一字未动,而**它守的东西又变了**:今天守的是"内存 store 的消息数组
 * 只有一个维护者"。往这个名单里加文件之前请先读 §16.25 第五节。
 *
 * (投影 reducer 改的是 `ProjectionNode`,不是 `ChatMessage`/`Step`/`ToolCall`,
 * 规则 B 本来就够不着它 —— 名单里不需要有它。)
 */
const RULE_B_ALLOWED = new Set([
  'packages/core/session/commands.ts',
])

const MUTATING_ARRAY_METHODS = new Set(['push', 'splice', 'pop', 'shift', 'unshift', 'sort', 'reverse'])
const MESSAGE_CHILD_ARRAYS = new Set(['steps', 'contentParts', 'toolCalls', 'childSteps'])

function isTestFile(rel) {
  return rel.includes('__tests__/') || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')
}

function shouldScan(rel) {
  if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) return false
  if (rel.startsWith('node_modules/')) return false
  if (rel.endsWith('.d.ts')) return false
  return (
    rel.startsWith('packages/core/') ||
    rel.startsWith('packages/onething-runtime/') ||
    rel.startsWith('packages/backend/') ||
    rel.startsWith('packages/gateway/') ||
    rel.startsWith('packages/shared/') ||
    rel.startsWith('apps/')
  )
}

function loadProgram() {
  const configPath = path.join(root, 'tsconfig.node.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, composite: false, noEmit: true, skipLibCheck: true },
  })
}

/** 属性存在性判断:泛型走 apparent type,联合类型只要有一支满足就算。 */
function hasProps(checker, type, names) {
  if (!type) return false
  if (type.isUnion()) return type.types.some(part => hasProps(checker, part, names))
  const apparent = checker.getApparentType(type)
  return names.every(name => Boolean(apparent.getProperty(name)))
}

function lacksProp(checker, type, name) {
  if (!type) return true
  if (type.isUnion()) return type.types.every(part => lacksProp(checker, part, name))
  return !checker.getApparentType(type).getProperty(name)
}

function isMessageLike(checker, type) {
  return hasProps(checker, type, ['id', 'role'])
}

/**
 * step 形状:`id` + `title` 还不够(搜索结果、目录条目都长这样),必须再带一个
 * step 独有的字段(toolCallId / childSteps / turnIndex / partialResult)。
 */
const STEP_MARKER_PROPS = ['toolCallId', 'childSteps', 'turnIndex', 'partialResult']

function isStepLike(checker, type) {
  if (!hasProps(checker, type, ['id', 'title'])) return false
  if (!lacksProp(checker, type, 'role')) return false
  return STEP_MARKER_PROPS.some(name => hasProps(checker, type, [name]))
}

function isToolCallLike(checker, type) {
  if (!hasProps(checker, type, ['status'])) return false
  if (!lacksProp(checker, type, 'role')) return false
  return (
    hasProps(checker, type, ['toolName']) ||
    hasProps(checker, type, ['arguments']) ||
    hasProps(checker, type, ['requiresConfirmation'])
  )
}

function elementTypeOf(checker, type) {
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
  if (indexed) return indexed
  const args = checker.getTypeArguments?.(type)
  return args && args.length === 1 ? args[0] : undefined
}

/**
 * 会话形状:有 `messages`(元素是消息形状)**且**带至少一个会话级字段。
 *
 * 后半条是必需的,否则 `room-rules.ts` 的 `effects.messages`(collab 回合的待发
 * 消息袋)与 provider 的 `request.messages` 会一起命中 —— 它们的元素确实长得像
 * 消息,但那不是"一条会话的消息日志"。
 */
const SESSION_MARKER_PROPS = [
  'updatedAt',
  'createdAt',
  'summaryUpToMessageId',
  'contextSize',
  'lastInputTokens',
  'workingDirectory',
]

function isSessionLike(checker, type) {
  if (!type) return false
  if (type.isUnion()) return type.types.some(part => isSessionLike(checker, part))
  const apparent = checker.getApparentType(type)
  const symbol = apparent.getProperty('messages')
  if (!symbol) return false
  if (!SESSION_MARKER_PROPS.some(name => apparent.getProperty(name))) return false
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return false
  const messagesType = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const candidates = messagesType.isUnion() ? messagesType.types : [messagesType]
  return candidates.some(candidate => {
    const element = elementTypeOf(checker, checker.getApparentType(candidate))
    return element ? isMessageLike(checker, element) : false
  })
}

function typeAt(checker, node) {
  try {
    return checker.getTypeAtLocation(node)
  } catch {
    return undefined
  }
}

function isMutableTarget(checker, node) {
  const type = typeAt(checker, node)
  if (!type) return false
  return isMessageLike(checker, type) || isStepLike(checker, type) || isToolCallLike(checker, type)
}

const findings = []

function report(sourceFile, node, rule) {
  const rel = path.relative(root, sourceFile.fileName)
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  findings.push({ file: rel, line: line + 1, rule })
}

function scan(sourceFile, checker) {
  const rel = path.relative(root, sourceFile.fileName)
  const test = isTestFile(rel)
  const allowA = test || RULE_A_ALLOWED.has(rel)
  const allowB = test || RULE_B_ALLOWED.has(rel)
  const allowC = test

  const visit = node => {
    // 规则 C:<session>.messages = …(整体赋值)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'messages' &&
      isSessionLike(checker, typeAt(checker, node.left.expression))
    ) {
      if (!allowC) report(sourceFile, node.left, 'session-messages-assign')
      ts.forEachChild(node, visit)
      return
    }

    // 规则 A:session.messages 的读
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'messages' &&
      !allowA &&
      isSessionLike(checker, typeAt(checker, node.expression))
    ) {
      report(sourceFile, node, 'session-messages-access')
    }

    if (!allowB) {
      // 规则 B-1:对消息/step/toolCall 的字段赋值
      if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        isMutableTarget(checker, node.left.expression)
      ) {
        report(sourceFile, node.left, 'message-field-assign')
      }

      // 规则 B-2:delete message.foo
      if (
        ts.isDeleteExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
        isMutableTarget(checker, node.expression.expression)
      ) {
        report(sourceFile, node.expression, 'message-field-delete')
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiver = node.expression.expression

        // 规则 B-3:Object.assign(message, …)
        if (
          method === 'assign' &&
          ts.isIdentifier(receiver) &&
          receiver.text === 'Object' &&
          node.arguments.length > 0 &&
          isMutableTarget(checker, node.arguments[0])
        ) {
          report(sourceFile, node, 'message-object-assign')
        }

        // 规则 B-4:message.steps.push(…) / .contentParts.splice(…) / …
        if (
          MUTATING_ARRAY_METHODS.has(method) &&
          ts.isPropertyAccessExpression(receiver) &&
          MESSAGE_CHILD_ARRAYS.has(receiver.name.text) &&
          isMutableTarget(checker, receiver.expression)
        ) {
          report(sourceFile, node, 'message-array-mutate')
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
}

const program = loadProgram()
const checker = program.getTypeChecker()
let scanned = 0
for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) continue
  const rel = path.relative(root, sourceFile.fileName)
  if (rel.startsWith('..') || !shouldScan(rel)) continue
  scanned += 1
  scan(sourceFile, checker)
}

findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
for (const finding of findings) {
  console.log(`[session] failed: ${finding.file}:${finding.line} ${finding.rule}`)
}
console.log(`[session] complete: ${scanned} file(s) scanned, ${findings.length} finding(s)`)
process.exit(findings.length > 0 ? 1 : 0)
