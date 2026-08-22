/**
 * RPC assembly point.
 *
 * `registerAppRpcDomains()` is the ONE line the assembly sequence runs and the
 * one place a new domain is listed — the target水位 of 主线 T: adding a domain
 * is a router file + a handler file + a line here, with zero shell edits.
 *
 * K0（内核收缩，docs/design/kernel-shrink-builtin-plugins-2026-08.md §3）：每个
 * 域现在是一个 **feature**（`rpc:<域>`），注册走 `FeatureContext`。对外的形状
 * 一个字没变 —— 仍然是「注册全部、返回总 disposer」；变的只是**接线方式**：
 * 注册项从此有主（`dumpFeatures()` 看得见谁注册了哪个域），卸载从「一串闭包」
 * 变成「逐 feature 逆序解绕」。域 handler 文件本身零改动。
 *
 * C2（cordis 采纳，docs/design/cordis-adoption-2026-08.md §2）：名册里出现了
 * 第一个**不是 `rpc:<域>` 薄包装**的成员 —— `trajectoryFeature` 从
 * `features/builtin/` 整个 import 进来，占的正是它从前那一格（`rpc:session-events`
 * 的位置），装配顺序一格未动。名册因此改名 `BUILTIN_FEATURES`：它列的是
 * **feature**，其中大多数今天恰好只注册一个 RPC 域。
 *
 * 为什么不另起一张表 + 另一条装配调用：那会把装配顺序拆成两处、并让
 * `backend.ts` 多一行 —— 与 C5「feature 名册 = 一个显式数组」的收口方向正好
 * 相反。一张有序表、一个入口，迁一个功能就是把一行内联包装换成一次 import，
 * 这是本期要证的形状。（遗留：函数仍叫 `registerAppRpcDomains`，名字比内容窄
 * 了半格 —— 改它要动 `backend.ts`，留给 C5 收口一起做。）
 */
import { acpRouter } from '@shared/ipc/acp.js'
import { agentsRouter } from '@shared/ipc/agents.js'
import { appStateRouter } from '@shared/ipc/app-state.js'
import { channelIdentityRouter } from '@shared/ipc/channel-identity.js'
import { chatRouter } from '@shared/ipc/chat.js'
import { collabRouter } from '@shared/ipc/collab.js'
import { goalRouter } from '@shared/ipc/goal.js'
import { logsRouter } from '@shared/ipc/logs.js'
import { markdownRouter } from '@shared/ipc/markdown.js'
import { mcpRouter } from '@shared/ipc/mcp.js'
import { mediaRouter } from '@shared/ipc/media.js'
import { permissionGrantsRouter } from '@shared/ipc/permission-grants.js'
import { permissionRouter } from '@shared/ipc/permissions.js'
import { practiceRouter } from '@shared/ipc/practice.js'
import { projectDirsRouter } from '@shared/ipc/project-dirs.js'
import { promptsRouter } from '@shared/ipc/prompts.js'
import { filesRouter } from '@shared/ipc/files.js'
import { gatewayRouter } from '@shared/ipc/gateway.js'
import { oauthRouter } from '@shared/ipc/oauth.js'
import { modelsRouter, providersRouter } from '@shared/ipc/providers.js'
import { schedulerRouter } from '@shared/ipc/scheduler.js'
import { scratchpadRouter } from '@shared/ipc/scratchpad.js'
import { sessionCommandRouter } from '@shared/ipc/session-command.js'
import { sessionsRouter } from '@shared/ipc/sessions.js'
import { skillsRouter } from '@shared/ipc/skills.js'
import { spacesRouter } from '@shared/ipc/spaces.js'
import { themesRouter } from '@shared/ipc/themes.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'
import { usageRouter } from '@shared/ipc/usage.js'
import { variablesRouter } from '@shared/ipc/variables.js'
import { selfEvolutionFeature } from '../features/builtin/self-evolution.js'
import { trajectoryFeature } from '../features/builtin/trajectory.js'
import { mountFeature, type FeatureDefinition, type FeatureUnmount } from '../features/index.js'
import { acpRpcHandlers } from './domains/acp.js'
import { agentsRpcHandlers } from './domains/agents.js'
import { appStateRpcHandlers } from './domains/app-state.js'
import { channelIdentityRpcHandlers } from './domains/channel-identity.js'
import { chatRpcHandlers } from './domains/chat.js'
import { collabRpcHandlers } from './domains/collab.js'
import { filesRpcHandlers } from './domains/files.js'
import { gatewayRpcHandlers } from './domains/gateway.js'
import { goalRpcHandlers } from './domains/goal.js'
import { logsRpcHandlers } from './domains/logs.js'
import { markdownRpcHandlers } from './domains/markdown.js'
import { mcpRpcHandlers } from './domains/mcp.js'
import { mediaRpcHandlers } from './domains/media.js'
import { modelsRpcHandlers } from './domains/models.js'
import { oauthRpcHandlers } from './domains/oauth.js'
import { permissionGrantsRpcHandlers } from './domains/permission-grants.js'
import { permissionRpcHandlers } from './domains/permission.js'
import { practiceRpcHandlers } from './domains/practice.js'
import { projectDirsRpcHandlers } from './domains/project-dirs.js'
import { promptsRpcHandlers } from './domains/prompts.js'
import { providersRpcHandlers } from './domains/providers.js'
import { schedulerRpcHandlers } from './domains/scheduler.js'
import { scratchpadRpcHandlers } from './domains/scratchpad.js'
import { sessionCommandRpcHandlers } from './domains/session-command.js'
import { sessionsRpcHandlers } from './domains/sessions.js'
import { skillsRpcHandlers } from './domains/skills.js'
import { spacesRpcHandlers } from './domains/spaces.js'
import { themesRpcHandlers } from './domains/themes.js'
import { todoPlanRpcHandlers } from './domains/todo-plan.js'
import { usageRpcHandlers } from './domains/usage.js'
import { variablesRpcHandlers } from './domains/variables.js'

/**
 * 内置 feature 的名册。**顺序即装配顺序**，与 K0 之前逐行调用的顺序逐字一致
 * （包装不重排：K0 的宪法是行为零变化）。
 *
 * 两种成员，同一张表：
 *  - **内联的 `rpc:<域>` 包装**（还没迁的那批）—— 一行一个域；
 *  - **import 进来的 feature**（已迁的）—— 一行一次 import，它自己决定要注册
 *    几项、注册什么。迁移一个功能 = 把前者换成后者，位置不动。
 */
const BUILTIN_FEATURES: FeatureDefinition[] = [
  // L3:渲染侧日志上行。排在最前 —— 它一个依赖也没有(只喂根 logger,
  // 而根 logger 在模块求值时就存在),而它接住的是**别人出问题时**的那条上行路。
  { id: 'rpc:logs', mount: ctx => { ctx.registerRpcDomain(logsRouter, logsRpcHandlers) } },
  { id: 'rpc:usage', mount: ctx => { ctx.registerRpcDomain(usageRouter, usageRpcHandlers) } },
  { id: 'rpc:prompts', mount: ctx => { ctx.registerRpcDomain(promptsRouter, promptsRpcHandlers) } },
  { id: 'rpc:goal', mount: ctx => { ctx.registerRpcDomain(goalRouter, goalRpcHandlers) } },
  { id: 'rpc:todo-plan', mount: ctx => { ctx.registerRpcDomain(todoPlanRouter, todoPlanRpcHandlers) } },
  // C2：轨迹是第一个迁成真 feature 的功能。它占的就是 `rpc:session-events`
  // 从前那一格 —— 顺序不变，变的是这一行说的是「哪件功能」而不是「哪个域」。
  trajectoryFeature,
  { id: 'rpc:channel-identity', mount: ctx => { ctx.registerRpcDomain(channelIdentityRouter, channelIdentityRpcHandlers) } },
  { id: 'rpc:agents', mount: ctx => { ctx.registerRpcDomain(agentsRouter, agentsRpcHandlers) } },
  { id: 'rpc:providers', mount: ctx => { ctx.registerRpcDomain(providersRouter, providersRpcHandlers) } },
  { id: 'rpc:models', mount: ctx => { ctx.registerRpcDomain(modelsRouter, modelsRpcHandlers) } },
  // 批 3：两个「带 context 的安全域」。护栏在 handler 里，靠 dispatch context
  // 的 sandboxRoot / owner 判定，不再由 server 壳自己抄一份。
  { id: 'rpc:markdown', mount: ctx => { ctx.registerRpcDomain(markdownRouter, markdownRpcHandlers) } },
  { id: 'rpc:permission-grants', mount: ctx => { ctx.registerRpcDomain(permissionGrantsRouter, permissionGrantsRpcHandlers) } },
  // P0.3:第一个从「手写 IPC 工厂 + 壳适配」整只搬过来的域(spaces)。搬完之后
  // server 侧一行没改 —— 域挂上 router 就经 `POST /api/rpc` 自动可达。
  { id: 'rpc:spaces', mount: ctx => { ctx.registerRpcDomain(spacesRouter, spacesRpcHandlers) } },
  // P4a 第二个域(practice)。与 spaces 同一条搬法,差别只在它连「手写 IPC 工厂 +
  // 壳适配」都没有 —— 旧线就是主进程里那十条裸 handle,所以搬完 `@main/ipc/practice.ts`
  // 只剩 PRACTICE_EVENT 的广播注入(router 没有推送面)。
  { id: 'rpc:practice', mount: ctx => { ctx.registerRpcDomain(practiceRouter, practiceRpcHandlers) } },
  // P4a 第三个域(collab)。与前两个的差别是它**一条推送都没有** —— 看板/协调器/
  // agent 的实时更新和表情回灌走的是会话事件,不是这个域的通道。所以搬完之后
  // `@main/ipc/collab.ts` 整只删掉,而不是像 spaces / practice 那样留一条广播。
  { id: 'rpc:collab', mount: ctx => { ctx.registerRpcDomain(collabRouter, collabRpcHandlers) } },
  // P4c 第一个域(scheduler)。旧线是三处镜像:手写 IPC 工厂 + 主进程壳、
  // 渲染侧九条 REST 桩(**零调用点**)、server 九条 REST 路由背后**自己那台**
  // per-owner Scheduler。搬完之后 server 与桌面吃的是同一台
  // `@onething/backend/wiring/scheduler` —— 一个 store 一台调度器。
  { id: 'rpc:scheduler', mount: ctx => { ctx.registerRpcDomain(schedulerRouter, schedulerRpcHandlers) } },
  // P4c 第二个域(variables)。旧线同样是三处镜像;与 scheduler 的差别是
  // server adapter 有一道桌面没有的「会话不存在 → NOT_FOUND」前置检查,搬家取的是
  // 桌面的形状 —— web 从此读的也是引擎真正在用的那台注册表(见域文件头)。
  { id: 'rpc:variables', mount: ctx => { ctx.registerRpcDomain(variablesRouter, variablesRpcHandlers) } },
  // P4c 第三个域(app-state)。这一个**不是零行为变化**:旧的 server adapter 现场
  // 拼一份最小状态(恒定的单页签 + 侧栏不折叠),搬到桌面那条实现之后 web 读的是
  // 同一个 store 的真 `app-state.json` —— 与 A 期「一个 store 一台 core」同向。
  { id: 'rpc:app-state', mount: ctx => { ctx.registerRpcDomain(appStateRouter, appStateRpcHandlers) } },
  // P4c 第四个域(permission,活询问的读/清)。应答不在这里 —— 那是命令总线上的
  // `command:permission-respond`;账页也不在这里 —— 那是 `permissionGrants` 域。
  { id: 'rpc:permission', mount: ctx => { ctx.registerRpcDomain(permissionRouter, permissionRpcHandlers) } },
  // P4c 第五个域(scratchpad)。与 spaces / practice 同型:四条数据面搬走,
  // `SCRATCHPAD_CHANGED` 那条推送留在原地(它早就是 `configureScratchpadHost` 端口,
  // 而 router 没有推送面),server 的 `/api/scratchpad/events` SSE 同样保留。
  { id: 'rpc:scratchpad', mount: ctx => { ctx.registerRpcDomain(scratchpadRouter, scratchpadRpcHandlers) } },
  // P4c 第六个域(project-dirs)。搬完顺带修掉一处说谎:web 壳原来把 `workspaceId`
  // 收下就丢,浏览器里切空间等于没切 —— 走 router 之后它真的传到
  // `getProjectsStore(workspaceId)` 了。
  { id: 'rpc:project-dirs', mount: ctx => { ctx.registerRpcDomain(projectDirsRouter, projectDirsRpcHandlers) } },
  // P4c 第二批唯一的域(skills)。它是本仓第一个**要宿主能力**的迁移域 ——
  // `openDirectory` 走新立的 `configureShellHost` 端口(`@onething/runtime/shell`),
  // 未注入即结构化降级,所以 server / CLI 不再需要那份「不支持」的空实现。
  // 顺带删掉了 server 侧那套 per-owner 的第二份技能实现(十三个 `*ServerSkill*` 助手):
  // 一个 store 一份技能表,web 与桌面从此读同一份。
  { id: 'rpc:skills', mount: ctx => { ctx.registerRpcDomain(skillsRouter, skillsRpcHandlers) } },
  // P4c 第三批唯一的域(media)。旧线上除了六条契约通道,还挂着**五条写死的字面量
  // 通道**(`media:save-image` / `media:load-all` / `media:delete` / `media:clear-all` /
  // `media:read-image-base64`)—— 不在 `IPC_CHANNELS` 里,transport 门连数都数不到。
  // 十一条数据面整只搬过来之后它们不再存在;留在宿主侧的是三条**要宿主本体**的:
  // 「另存为」的原生对话框与两个 `BrowserWindow`(预览窗 / 画廊窗)。
  // `getPreview` 跟数据走 —— 开窗那半写、这半读,两边共用 runtime 里那本
  // `image-preview-registry-bound` 的进程内登记簿。
  { id: 'rpc:media', mount: ctx => { ctx.registerRpcDomain(mediaRouter, mediaRpcHandlers) } },
  // P4c 第四批唯一的域(session-command)—— **会话命令总线的入口**,全仓最后一条
  // 主干「Proxy 属性 + 手写通道」。它只有一个方法(`emit`):分派在总线那一侧按
  // `command.type` 走,router 再劈一遍等于把同一张表抄两份。搬完之后渲染层那一行
  // `sessionCommands.emit(...)` 到 `handleSendMessage` 每一跳都是 TS 标识符。
  // 位置在 media 之后、自进化之前:它要 `getStreamEngine()`(http 上的 abort 分支)
  // 与 `Permission`(权限应答认领 targetChannel),而 `backend.ts` 的顺序是
  // 引擎 → Permission → 工具注册 → registerAppRpcDomains,注册时两者都已就位。
  { id: 'rpc:session-command', mount: ctx => { ctx.registerRpcDomain(sessionCommandRouter, sessionCommandRpcHandlers) } },
  // P4c 第五批唯一的域(sessions)—— 全仓最大的一域,26 条:22 条旧 `IPC_CHANNELS.*`
  // 加**四条契约表外的字面量通道**(add-system-message / remove-files-changed-message /
  // remove-git-status-message / remove-message),搬完之后后四条不再存在。
  // 位置在 session-command 之后:两者互不依赖(会话仓是模块级单例),但读面排在
  // 写面之后与「先有总线、再有查询」的叙事一致;真正的硬约束只有一条 —— 必须在
  // 自进化之前,因为卸载要逆序。
  { id: 'rpc:sessions', mount: ctx => { ctx.registerRpcDomain(sessionsRouter, sessionsRpcHandlers) } },
  // P4c 第五批的第二个域(chat)—— 聊天面剩下的六条:历史 / 标题 / 提示词快照 /
  // 思考时长 / 停止 / 活流表。**第七条 `RESUME_AFTER_TOOL_CONFIRM` 不在这里**
  // (拍板 #21):它往引擎递 `sender`,信封里没有那一格,原样留在手写 IPC 上。
  // 位置在 sessions 之后:`abortStream` 要 `getStreamEngine()` 与 `Permission`,
  // 而 `backend.ts` 的顺序是引擎 → Permission → 工具注册 → registerAppRpcDomains,
  // 注册时两者都已就位;硬约束仍只有一条 —— 必须在自进化之前(卸载要逆序)。
  { id: 'rpc:chat', mount: ctx => { ctx.registerRpcDomain(chatRouter, chatRpcHandlers) } },
  // P4c 第六批第一个域(acp)—— 八条外部 agent 的增删改 / 连断 / 刷新 / 取消。
  // 它一条推送都没有:agent 连上以后的流是**会话事件**,不是这个域的通道,所以
  // `apps/electron/src/ipc/acp.ts` 整只删掉(同 collab 判例)。位置在 chat 之后、
  // 自进化之前:它只要 `ACPManager` 的进程内单例与设置缓存,两者在装配到这一步时
  // 都早已就位;硬约束仍只有一条 —— 必须在自进化之前(卸载要逆序)。
  { id: 'rpc:acp', mount: ctx => { ctx.registerRpcDomain(acpRouter, acpRpcHandlers) } },
  // P4c 第六批第二个域(mcp)—— 十六条:服务器增删改 / 连接生命周期 / 能力面 /
  // 配置导入。它与 acp 一样零推送(server 推来的 list-changed 由客户端就地回灌,
  // 再经 `configureMCPCapabilitiesChangedHandler` 重生成模型面目录,不过传输面)。
  // 本域是本批唯一**带 context 分叉**的:私密字段脱敏、更新时合并回真值、
  // `readConfigFile` 在 http 上不读本机文件、stdio 探测在 http 上默认关闭(见域文件头)。
  // 位置在 acp 之后、自进化之前 —— 同一条约束:卸载要逆序。
  { id: 'rpc:mcp', mount: ctx => { ctx.registerRpcDomain(mcpRouter, mcpRpcHandlers) } },
  // P4c 第七批第一个域(themes)—— 五条:列表 / 单取 / 应用 / 刷新 / 打开目录。
  // 它零推送(系统深浅色变化走的是 `SYSTEM_THEME_CHANGED`,那是设置域的推送,
  // 不是这个域的通道),所以 `apps/electron/src/ipc/themes.ts` 与
  // `@main/ipc/themes.ts` 整只删掉(同 acp / collab 判例)。
  // 两处口径变化写在域文件头:插件主题覆盖的合成从 `@main` 搬进了处理者(server
  // 顺带获得,拍板 #20),`openFolder` 改走 `configureShellHost` 端口。
  // 位置在 mcp 之后、自进化之前:它只要主题运行时的进程内单例与插件清单,
  // 两者在装配到这一步时都早已就位;硬约束仍只有一条 —— 必须在自进化之前。
  { id: 'rpc:themes', mount: ctx => { ctx.registerRpcDomain(themesRouter, themesRpcHandlers) } },
  // P4c 第七批第二个域(oauth)—— 六条数据面。**两条推送留在原地**:
  // `OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 改成注入端口
  // (`configureOAuthEventBroadcaster`,同 practice / scratchpad 判例),
  // 桌面推 webContents、server 串联进 `GET /api/oauth/events` 那条 SSE。
  // server 那台 per-owner 的第二台 authService 随之消失 —— 一个 store 一本令牌账。
  // 位置在 themes 之后、自进化之前:同一条约束(卸载要逆序)。
  { id: 'rpc:oauth', mount: ctx => { ctx.registerRpcDomain(oauthRouter, oauthRpcHandlers) } },
  // P4c 第八批第一个域(gateway)—— 八条:状态 / 起停 / 微信账号增删改与登出。
  // 八条全都要**宿主本体**(主进程拉起来的子进程 + 一张二维码),所以域处理者
  // 走 `wiring/gateway/host-ports.ts` 的 `configureGatewayHost`:桌面在
  // `main-process.ts` 注入八行转调,server / CLI 不注入 —— 拿到的是结构化降级,
  // 而不是旧 server adapter 那句写死的「server runtime 上网关已禁用」。
  // **本域零推送**(全仓没有 `GATEWAY_*_CHANGED`),所以 `@main/ipc/gateway.ts`
  // 整只删掉,不像 oauth 还要留一层广播注入。
  { id: 'rpc:gateway', mount: ctx => { ctx.registerRpcDomain(gatewayRouter, gatewayRpcHandlers) } },
  // P4c 第八批第二个域(files)—— 十四条,也是全仓**第一个逐方法带 http 夹紧**
  // 的域(#19 的安全面):`transport:'ipc'` 不夹(桌面与迁移前逐字同义)、
  // `transport:'http'` 每条带路径的方法都夹进 `sandboxRoot`,越界文案逐字沿用
  // 旧 server 路由的原话。三处 http 分叉(`list` 的搜索根 / `reveal` 要外壳端口 /
  // `watchStart|Stop` 桌面是投影桩而 http 是真监视器)逐条写在域文件头的表里。
  // 一条推送留在原地:`FILE_WATCH_EVENT` 与它在 server 那侧的 SSE 源,
  // 登记簿搬到 `wiring/files/workspace-watch.ts`,请求面与推送面共用同一张表。
  { id: 'rpc:files', mount: ctx => { ctx.registerRpcDomain(filesRouter, filesRpcHandlers) } },
  // C4 第一档:自进化。名册里第一个**一个 RPC 域都不注册**的成员 —— 它注册的
  // 是三个会话工具(feature_mount / feature_unmount / feature_inspect)。
  //
  // 位置在**最后**且不可上移:它的工具注册面有一道「已经有 bash 的宿主才给」的
  // 门(见该文件头),判据要在工具注册表装好之后才为真;而 `backend.ts` 的顺序
  // 恰好是「三档工具注册 → registerAppRpcDomains」。放在末尾还有第二重意义:
  // 卸载时它第一个被解绕,模型现场挂进来的那批动态 feature 因此在内置域拆掉
  // **之前**就已经收干净(动态 feature 可能骑在这些域上)。
  selfEvolutionFeature,
]

/** Bind every builtin domain. Returns a disposer that unbinds all of them. */
export async function registerAppRpcDomains(): Promise<() => Promise<void>> {
  const unmounts: FeatureUnmount[] = []
  for (const feature of BUILTIN_FEATURES) {
    unmounts.push(await mountFeature(feature))
  }
  return async () => {
    // 逆序：与 FeatureContext.disposeAll 同一惯例（后挂的先卸）。
    for (let i = unmounts.length - 1; i >= 0; i -= 1) await unmounts[i]()
  }
}

export {
  dispatchRpc,
  hasRpcDomain,
  registerRouterHandlers,
  resetRpcRegistryForTests,
} from './registry.js'
