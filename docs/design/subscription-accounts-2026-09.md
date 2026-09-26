# 订阅账号:是谁的、怎么登、怎么列、怎么迁(方案,2026-09-26)

用户 09-26 报障:「订阅登录,添加账号会覆盖上一个账号(OpenAI),其他的可能也有类似的问题」;追问「我用的不是默认空间」;裁定「先停一下,好好设计一下方案」。

## 0. 病根(代码坐实)

三处同一个根,每一家订阅(Codex / Claude / Kimi Code / Grok / Copilot)都一样:

1. `runtime/src/auth/credential-target.ts:95` `normalizeCredentialTarget`:`spaceId` 缺席、非法、或等于默认空间,一律归到 **settings 层的单槽** `<store>/oauth-tokens.json`(`token-store.ts`,一家一把令牌)。第二次登录 = 盖掉第一把。只有「非默认空间 + 带 spaceId」才走池追加(`space-token-store.ts saveToken`,`entryId` 缺席 = 追加)。
2. 壳 `providers/store.ts:1547` `oauthStart({ providerId })` **从不带 `spaceId`**(批 1 留账),`rpc/domains/oauth.ts:67 targetOf` 于是归到单槽 —— 所以**你在哪个空间登录都一样**,全落那一把。
3. 读路 `backend/wiring/providers/space-credentials.ts:451-458 resolveSessionSpaceOAuthAuth`:默认空间仍读单槽;C1 迁移(08-18)把老令牌搬进了默认空间的池,但池里那条从此只是「登没登」的标记。批 5 留账「默认空间多账号拿到的是同一份配额」同根。

**一条待核的事实**:非默认空间的池里没有 oauth 条目时,`resolveSpaceProviderCredential` 会答 `unavailable{reason:'oauth'}`「还没有登录过」。你在自己的空间里登录后能不能发出去、靠的是哪条路(单槽回落?池里被谁 upsert 了一条?),施工前要在真 store 形状上核一次,别猜。

## 1. 先定一件事:账号是谁的

密钥池的隔离律(`workspace-spaces-2026-08.md` 08-13 拍板):**API 密钥 per-space 严格隔离,不回落全局**;新建空间时「导入」= 复制快照。OAuth 账号在那份设计里也按同一条走,并加了一句理由:「token 不能复制,refresh 轮换下两个空间共用一串 refresh token 会互相作废,所以每个空间必须自己登录一次」。

这句理由是对的,但它反对的是**复制**,不是**共享一份**。API 密钥是一串可以复制的字;OAuth 账号是一个**身份**,令牌会轮换,天然只能有一份。把「身份」按空间复制,结果就是今天:要么每个空间重登(重),要么各空间抄同一串令牌互相作废(错)。所以这件事得先定形:

| 候选 | 账号存哪 | 空间看到什么 | 换空间要不要重登 | 隔离 | 令牌轮换 |
| --- | --- | --- | --- | --- | --- |
| **A 账号全局、空间引用**(推荐) | 一份全局账号册 `<store>/accounts.json`:每个账号一条 `{ id, providerId, accountId / email / plan, token(加密), addedAt }` | 空间的池里 oauth 条目是**引用** `{ authType:'oauth', accountRef }`,外加这个空间自己的顺序 / 冷却 / 策略 | 不要:在任一空间登过的账号,别的空间可「引用」进来 | 有:空间只用它引用了的账号(个人号 / 公司号分得开) | 安全:全机器只有一份令牌,谁刷新都是它 |
| B 账号按空间各存各(今天的制度修好) | 每个空间的 `credentials.json` 里 oauth 条目**内联**令牌 | 自己池里的 | 要:每个空间各登一次 | 有 | 安全,但代价是重登 |
| C 账号全局、空间不分 | 同 A 的账号册 | 所有空间都看到所有账号 | 不要 | **没有**:个人号会在公司空间里被轮到 | 安全 |

**推荐 A。** 理由三条:①身份只能有一份,A 是唯一既不复制令牌又不重登的形;②隔离靠「引用哪几个」达成,与 API 密钥的隔离律精神一致(空间各选各的),只是从「复制值」改成「引用身份」;③配额(批 5)与路由(批 6)本来就按账号算,账号全局之后一个账号的 5 小时窗在哪个空间看都是同一份数,不再出现「默认空间多账号共一份配额」这类账。B 是最省工的止血(壳带 spaceId + 目标归一 + status 按条),但它把「重登」这个重量留给用户,而且 C1 之后默认空间「不是特例」这句在 OAuth 上仍然是假的。C 不考虑。

## 2. A 形下的数据形状

```
<store>/accounts.json                       # 全局账号册(加密与 credentials.json 同法:safeStorage,不可用时明文 + 标记)
{
  version: 1,
  accounts: [
    { id: 'acc_…', providerId: 'codex', accountId: 'chatgpt_account_id', email, planType, addedAt,
      token: { accessToken, refreshToken, expiresAt, idToken?, providerMetadata? } }
  ]
}

workspaces/<id>/credentials.json            # 空间的池(已有),oauth 条目改成引用
providers.codex.entries[] = [
  { id: 'e1', authType: 'oauth', accountRef: 'acc_…', label?, cooldownUntil?, cooldownReason? },
  …
]
```

- **账号身份键** = `providerId + accountId`(Codex 的 JWT 里有 `chatgpt_account_id`;Claude 的 OAuth 令牌没有账号字段,用 `email` 或 `/api/oauth/profile` 一次取回的 id;取不到的家用「首次登录时间 + 随机 id」当身份,不去重)。同一身份再登一次 = 更新令牌,不是第二条。
- **空间引用条目**只带这个空间自己的事:顺序、冷却(报错 / 配额)、备注。令牌与身份一律去账号册取。
- **默认空间**从此真的不是特例:它的池里也是引用。`SETTINGS_CREDENTIAL_TARGET` 与 `oauth-tokens.json` 整个退役(读路不再回落),迁移后文件改名留底。

## 3. 登录、引用、退出

| 动作 | 在哪 | 做什么 |
| --- | --- | --- |
| 添加账号(新登录) | 空间的订阅卡 | 起登录流(`oauth.start { providerId, spaceId }`);完成后:账号册 upsert(按身份键)+ 本空间池追加一条引用。同一身份已在册且本空间已引用 → 只更新令牌,不加第二条 |
| 引用已有账号 | 空间的订阅卡「添加账号」旁的第二入口 | 弹一列账号册里这家**本空间还没引用**的账号(邮箱 / 套餐 / 加入时间),选一个 = 追加一条引用,不走登录 |
| 重新授权 | 账号行 | `oauth.start { providerId, spaceId, entryId }`:完成后按身份键更新账号册那一条(所有引用它的空间同时受益) |
| 移除 | 账号行 | 只删本空间的引用;账号册那条不动(别的空间可能还在用) |
| 退出登录(吊销) | 全局「账号」页(设置 → 账号,或订阅卡里账号行 ⋯ 菜单最后一项) | 删账号册那一条 + 所有空间里指向它的引用;有别的空间在引用时确认句写清「N 个空间也会失去它」 |

登录流本身不变(批 1 已在后端);流的键 = `(providerId, spaceId, entryId | *)`。

## 4. 状态表

订阅卡(某个空间 × 某一家),行 = 账号册与本空间引用的组合:

| 情形 | 卡片显示 | 可做的动作 |
| --- | --- | --- |
| 册里没有这家账号 | 「登录」一颗 + 一句说明(批 0 文案) | 登录 |
| 册里有、本空间没引用 | 「登录」+「引用已有账号(n)」 | 登录 / 引用 |
| 本空间引用了 1 个 | 一行:邮箱 · 套餐 · 窗口条(批 5)·(过期标) | 重新授权 / 移除 / 添加账号 / 引用 |
| 引用了 ≥2 个 | 每账号一行,顺序可拖(顺序 = 余量相同时的优先级) | 同上 |
| 某账号令牌过期 / 刷新被拒 | 该行「登录已过期」+ 重新授权 | 重新授权 / 移除 |
| 某账号配额窗满 | 该行窗口条满格 + 「{time} 重置」;路由自动跳过它 | — |
| 网页壳 | 同上,登录走链接(批 1) | 同上 |

composer 卡片(批 5):显示「这一发会用哪条」的账号窗口;路由(批 6)在本空间引用的账号里按余量排,顺序作平局。

## 5. 归位(一次性,装配时)

按 `storage.oauthAccountsMigratedAt` 标记只跑一次;只追加不删,原文件留底:

1. 扫每个空间的 `credentials.json`:内联令牌的 oauth 条目 → 账号册 upsert(身份键去重;同身份多份时 `expiresAt` 最大者赢)→ 条目改成引用。
2. 扫 `oauth-tokens.json`(单槽):每家一把 → 账号册 upsert(同身份 → 同上取新)→ **默认空间**追加引用(单槽里的令牌没有空间归属,默认空间是唯一确定的家)。
3. 文件改名 `oauth-tokens.migrated-<ISO>.json`;每个空间的 `credentials.json` 先 `copyFileToBackup`。
4. 归位后:非默认空间若原先靠单槽在用某家(§0 待核那条路),它的池里没有引用 → 卡片显示「引用已有账号(1)」,用户点一下即可,不必重登。

## 6. 影响面

- 类型:`SpaceCredentialEntry` 的 oauth 变体从 `oauthToken` 改成 `accountRef`(读时兼容旧形一次,写时只写新形);新 `OAuthAccount`;`OnethingCredentialTarget` 的 `settings` 变体删。
- 存储:`accounts.json` 读写 + 加密(照 `credentials.ts` 的 safeStorage 做法);`token-store.ts` 退役。
- 认证:`auth-service.ts` `writeToken` / `refreshTokenIfNeeded` / `resolveProviderAuth` 按账号册取放,单飞锁键改成账号 id(两个空间引用同一账号时刷新只发一次 —— 这正是 A 形的收益)。
- RPC:`oauth.start/callback/refresh/status/logout` 带 `spaceId` + `entryId`;`status` 答 `accounts[]`;新 `oauth.listAccounts { providerId }`(册里这家所有账号)与 `oauth.reference { providerId, spaceId, accountId }`(追加引用)、`oauth.unreference`;`logout` 语义 = 吊销(§3)。
- 配额(批 5)/ 路由(批 6):缓存键与候选按账号 id;两处只改「令牌从哪取」。
- 壳:订阅卡账号列表(复用 `CredentialPool` 那一族的行与菜单)、「引用已有账号」小浮层(复用 `Menu` / `Popover`)、store 带 spaceId / entryId;文案我逐字定进派工单。
- 门:`gate:providers-auth` 加:非默认空间登两个账号各自成行、第二个不盖第一个;引用不重登;重新授权更新册且另一空间同时受益;吊销清所有引用;老 store 归位(单槽 + 内联条目)且文件留底。`gate:quota` 加:两账号各答各的窗口。

量:约 2 天(B 形约 1 天)。

## 7. 拍点(09-26 已拍)

1. **账号模型:B 按空间各存各**(用户拍定)。A 的账号册与引用**不做**;§2 / §3 / §5 里 A 形的部分作废,以下 §8 为准。
2. 引用范围:不适用。
3. 退出语义:空间里「退出」= 删本空间那一条 oauth 条目(令牌随之删;不向服务商吊销)。
4. 单槽令牌归位:进默认空间;别的空间重登一次。
5. 账号顺序:余量优先(批 6 已拍),手动顺序作平局。

## 8. B 形的施工单(批 8)

**目标**:每个空间的池里,一家订阅可以有多条 oauth 条目,各自内联自己的令牌;新登录追加、重新授权原地换、退出删那一条;默认空间不是特例;单槽 `oauth-tokens.json` 退役。

1. **目标归一**:`normalizeCredentialTarget` 对 `DEFAULT_SPACE_ID` 返回 `{ kind:'space', spaceId:'default', entryId?, label? }`;`spaceId` 缺席(老调用方 / CLI)= 默认空间的 space 目标。`SETTINGS_CREDENTIAL_TARGET` 与 `token-store.ts` 的写路退役;读路在**归位完成后**不再回落单槽(归位是装配序列里的一格,先跑)。
2. **壳带空间与账号**:`store.ts` 的 `startAuth` / `submitCode` / `cancelAuth` / `checkAuth` / `signOut` / 重新授权都带 `spaceId: currentSpaceId()`;「添加账号」不带 `entryId`(追加),「重新授权」带那条的 `entryId`(原地换令牌),`signOut(providerId, entryId)` 删那一条。同一身份(Codex `chatgpt_account_id`;其它家 `email`,取不到就不去重)再登一次 = 更新那一条,不出第二行。
3. **状态按条目**:`oauth.status { providerId, spaceId, entryId? }`:带 `entryId` 答那一条;不带答池里第一条(兼容)并加 `accounts: Array<{ entryId, label, email?, planType?, isExpired, expiresAt? }>`;`OAuthCard` 已登录屏每账号一行(邮箱 · 套餐 · 窗口条(批 5)· 过期标 · 重新授权 · 退出),`subAccounts` 计数读同一份;行可拖(顺序 = 余量平局时的优先级,写池的 `entryIds` 顺序)。
4. **归位**(装配时一次,`storage.oauthSlotMigratedAt` 标记):`oauth-tokens.json` 每家一把 → 默认空间池:同身份的条目更新令牌(`expiresAt` 大者赢),无同身份则追加;做完改名 `oauth-tokens.migrated-<ISO>.json`,池文件先 `copyFileToBackup`。非默认空间不动(用户重登)。
5. **待核事实**(§0):非默认空间今天靠哪条路发出去的。施工前在临时 store 复现一次并写进回报;若发现某处把单槽令牌 upsert 进过空间池,归位也要覆盖那条路。
6. **配额 / 路由**:`QuotaService` 与 `pickRoute` 已按 (provider, entry) 走;核对默认空间多账号各拿各的令牌(批 5 留账关掉)。
7. **门**:`gate:providers-auth` 加:①非默认空间登两个账号 → 池里两条、第一条令牌未变、发一轮用的是池里那条;②默认空间同上;③`oauth.status.accounts` 两条各自 entryId;④退出其中一个,另一个仍在且能发一轮;⑤老 store(单槽 + 池里一条旧令牌)装配后池里是新令牌、文件已改名。`gate:quota` 加:两账号各答各的窗口。

量:约 1 天。

## 9. 入库记录与留账(09-26)

批 8 已入 main(紧随 cee24930b 的那一笔)。施工前核清的事实(§0 待核那条):**非默认空间从来发不出去** —— 壳的登录落单槽,空间池为空,发一轮报 `ProviderNotConfigured`「还没有登录过」,不回落、不出网;带 `spaceId` 调 `oauth.start` 就能追加两条并用池里那条发出去,壳只是从没这么调过;默认空间第二次登录盖单槽,默认池一直空;除 C1 一次性迁移外没有任何一处把单槽令牌 upsert 进空间池。

偏离设计:窗口条没塞进账号行(批 5 的 `UsageCard` 仍是每账号一张卡在登录卡下面);行拖拽改成 ⋯ 菜单里的上移 / 下移;归位时无匹配的单槽令牌插到默认池**最前**(它就是默认空间今天在用的那把,行为不变),C1 留下的旧副本不删;单槽里加密令牌而本进程没有解密适配器时不归位、不改名、不记标,等桌面来做;Codex 身份键并入 `chatgptUserId`(同一团队工作区两个人不合成一行)。

留账:①**托管 fetch 忽略 `HTTP(S)_PROXY` 环境变量**,只认设置里的 `network.proxy` —— 施工探针里假令牌真打到了 `api.kimi.com`(拿回真 401);`gate:route` / `gate:quota` 靠环境变量挡出网,今天端点都指向本地假站所以没事,但这两道门的「不出网」保证是假的,要改成设置路(`gate:providers-auth` 已改);②`batch2-ui.test.tsx` 三条 `_` 未使用的 eslint 红是存量。

## 10. 订阅账号的轮转(批 9,用户 09-26:「订阅也需要能够轮转,另外增加一个轮转方式:根据 usage 来确定,如果一个用完了,用另一个」)

**今天的缺口**:批 6 的 `pickRoute` 对订阅账号**强制**按「最紧窗口的剩余量从多到少」排,池策略对它不起作用;设置页订阅卡上也没有策略选择器(只有 API 池的 `CredentialPool` 有)。所以「按顺序用,用完再换,恢复后换回」这种排法今天做不到。

**形**:订阅池与 API 池同一个策略选择器,四档;`SpaceCredentialPolicy` 加一档 `'quota-remaining'`:

| 策略 | 标签 | 说明句(设置页) | 订阅池的语义 | API 池的语义 |
| --- | --- | --- | --- | --- |
| `single` | 只用第一个 | 只用第一个账号。 | 只取第一条可用 | 不变 |
| `priority-failover`(**订阅池默认**) | 用完换下一个 | 按顺序使用,额度用完自动换下一个,恢复后换回。 | 按池内顺序取第一条**未用完**的:配额冷却(批 5,窗口满 → `resets_at`)∪ 报错冷却;窗口重置后自然回到前一条 | 不变(标签仍「按序接力」,说明「按顺序使用,失效时自动换下一个。」) |
| `round-robin` | 轮流使用 | 每次请求轮流使用。 | 不变 | 不变 |
| `quota-remaining`(新) | 余量多的优先 | 每次用剩余额度最多的账号。 | 批 6 今天的排法,原样搬进这一档 | 只在有余额源的家显示;无余额数据退化为按序 |

「用完」的判据:最紧那个窗口 `usedPercent >= 100`(配额缓存里的最新一份,含被动源响应头),或服务商报 `usage_limit_reached` / 429 配额类错误(批 6 已判成配额耗尽)→ 冷却到 `resets_at`(缺席 10 分钟)。发送前 `pickRoute` 读的是同一格冷却,不另开判据。

**默认值**:订阅池新建时 `priority-failover`(用户要的就是这个行为);已有池没写策略的照 `normalizeSpaceCredentialPolicy` 的缺省(批 6 改成了 `priority-failover`),所以存量池也是它。想要批 6 的老排法就选「余量多的优先」。

**UI**:`OAuthCard` 已登录屏、账号列表上方,放与 `CredentialPool` 同一个策略选择器(把 `CredentialPool` 里 `rotationOptions` / `rotationHint` 那一段抽成共用的 `RotationPolicyPicker`,两处消费;不新建基础件);≥2 个账号才显示。API 池的选择器多一档「余量多的优先」,只在 manifest 有 `quotaSource` 的家显示。

**门**:`gate:route` 加:①订阅池 `priority-failover`:A 40% / B 10% → 选 A(顺序优先,不看余量);A 满 → B;A 重置 → 回 A;②`quota-remaining`:A 40% / B 10% → 选 B;③`round-robin` 两账号交替;④策略选择器写盘后 `pickRoute` 立刻按新策略(不用重启)。
