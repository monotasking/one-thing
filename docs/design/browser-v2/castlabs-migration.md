# castlabs Electron 迁移 — 内嵌浏览器登录 Google

> **已退役(2026-09-03,用户拍板)。本文自此是历史记录,不是现状。**
> 仓根依赖换回官方 `electron@41.1.1`(同大版本,内嵌 Node 24.14 / ABI 145 不变),
> `experiment/castlabs-electron` 分支本地与 origin 均已删除。
> 随之作废的现状描述:`package.json` 的 github 依赖串、`electron-builder.yml` 的
> `electronDist` 与 `npmRebuild:false` 的旧理由、下文 §"分发要补的 EVS 脚手架"。
> **代价(用户已接受)**:官方构建不带 Widevine CDM,`ensureWidevineReady()` 在生产上
> 恒为 no-op,内嵌浏览器不再能播 DRM 内容。UA + FedCM 那两格登录配方与 CDM 无关,
> 但换核后**未重验**,记在 `apps/electron/src/browser/session.ts` 文件头。
> 换回来的理由:一个不在官方下载源、node-abi 不认版本号的定制底座,把打包链逼出了
> 一串只为它存在的变通,而它换来的能力(DRM 播放)今天没有产品在用。
>
> 分支 `experiment/castlabs-electron`。2026-07-26 落地，真机已验证内嵌浏览器可登录 Google。

## 为什么

onething 的内嵌浏览器（WebContentsView，`docs/design/browser-v2.md`）在官方 Electron 上登录 Google 会被拦：**"此浏览器或应用可能不安全 / This browser or app may not be secure"**。目标是让它像成熟浏览器一样能登录真实 Google 账号，而不是把登录甩给系统浏览器（那等于承认"假浏览器"）。

参照物：**Flow Browser**（`~/data/code/flow-browser`）—— 用户实测它的内嵌浏览器**能**登录 Google。逐项对齐后复刻成功。

## 破案过程（关键，别重走弯路）

不再猜指纹，用同一张 `fp.html` 把**能登的 Flow** 和**登不了的测试**各 dump 一份指纹对比：

| 信号 | Flow(能登) | 我的失败测试 | 结论 |
| --- | --- | --- | --- |
| `window.chrome.runtime/loadTimes/csi` | 全 false | 全 false | **一样,不是它** |
| `navigator.userAgentData.brands` | 仅 Chromium | 仅 Chromium | **一样,不是它**(无 "Google Chrome" 品牌 Flow 也照登) |
| Widevine (`requestMediaKeySystemAccess`) | OK | OK | **一样,不是它** |
| `navigator.webdriver` | false | false | 一样 |
| **UA app token** | `Flow/0.12.0` **在** | **不在**(被我洗掉了) | **← 唯一实质差别** |

**根因（反直觉）**：我之前把 UA 洗得"太干净"——冻结成 `Chrome/146.0.0.0` + 删掉 app token——反而像**假的**，触发拦截。Flow 的做法相反：**最小改动，只摘 `Electron/xxx` 一个 token**，app token（`Flow/0.12.0`）和完整构建号（`Chrome/146.0.7680.166`）全留。补上后立即通过。

## 已验证配方（四件）

1. **castlabs Electron fork**：`electron: "github:castlabs/electron-releases#v41.1.1+wvcus"`（= Chromium 146.0.7680.166）。官方 Electron 缺 Widevine，且非 castlabs 底座上同样配方登不了 → 换核是前提。与 Flow 同一确切版本。
2. **关 FedCM**：`app.commandLine.appendSwitch('--disable-features', 'FedCm')`，app ready 之前。FedCM 在 Electron 里是坏的，其存在本身会拌倒 Google 的登录环境检测。
3. **Widevine 就绪**：`await components.whenReady()`（castlabs 命名导出），建 WebContentsView 前。dev 用自带 dev-CDM，免签。
4. **UA 最小洗**：只删 ` Electron/<ver>`，保留 app token（`onething/x.y.z`）+ 完整构建号。

## 代码落点（本分支改动）

| 文件 | 改动 |
| --- | --- |
| `package.json` | electron 依赖换 castlabs；`trustedDependencies:["electron"]`（bun 默认拦 github 源 postinstall，需放行下载二进制） |
| `apps/electron/src/browser/session.ts` | `buildChromeUserAgent` 改为 `defaultUserAgent.replace(/\sElectron\/\S+/, '')`（原来是造冻结版 UA，正是失败主因） |
| `apps/electron/src/browser/chromium-flags.ts` | **新增**：`applyEmbeddedBrowserChromiumFlags()` 设 FedCm 开关（放 host 层，main-process 不能直接 import electron——boundary 规则） |
| `apps/electron/src/browser/widevine.ts` | **新增**：`ensureWidevineReady()`，`components.whenReady()` 记忆化 + runtime guard |
| `apps/electron/src/browser/service.ts` | 构造器里 `void ensureWidevineReady()`；import widevine |
| `apps/electron/src/app/main-process.ts` | 启动时调 `applyEmbeddedBrowserChromiumFlags()`（不 import electron） |
| `apps/electron/src/browser/identity.ts` | **删除**：CDP 注 "Google Chrome" 品牌的旧路子，已被证伪（Flow 不做也照登），死代码 |
| `onething.aliases.ts` | 删 `identity` alias，加 `chromium-flags` alias |

门禁：typecheck 绿、boundary:gate 绿（还治好 2 个基线红）。

## DEV 要求

- `bun install` 后需 `bun pm trust electron` 跑 postinstall 下载二进制（bun 默认拦 github 源脚本）。已在 `trustedDependencies` 声明，正常 install 会自动放行。
- **首次启动需联网**：Widevine CDM 不在 dist 里，Electron 组件更新器首启下载。
- 原生模块：node-pty / sherpa 是懒加载 + N-API（ABI 稳定，跨 Electron 版本通用），无需按 41 重建；better-sqlite3 只在 apps/server(node) 用，主进程不碰。macOS 原生面板 `bun run build:native:mac` 重建即可。
- `bun run electron:dev` 会自动跑 `sign:dev:mac`（ad-hoc 签名让原生模块在 macOS 可加载）。castlabs 二进制本身是 adhoc（**已证明 adhoc 状态能登**），脚本有守卫不会签坏。

## 生产分发签名 playbook（分发才需要，dev 不需要）

castlabs Widevine 在**分发的签名 app** 里生效，需要 castlabs EVS 的 VMP 签名。onething 现在的 `electron-builder.yml` / CI 完全没有这套脚手架，distribute 前要补：

**一次性**：注册 castlabs EVS 账号并接受 Widevine 条款（`python3 -m castlabs_evs.account signup`），账号名/密码存 CI secret。

**每次构建**（顺序不能错）：
1. 装 EVS：`python3 -m castlabs_evs.pip install castlabs-evs==1.1.5 --break-system-packages`（钉版本，同 Flow）。
2. 认证：`python3 -m castlabs_evs.account --no-ask reauth -A $ACCOUNT -P $PASSWD`。
3. **macOS**：electron-builder `afterPack` 钩子里、Apple codesign **之前**跑 `python3 -m castlabs_evs.vmp --no-ask sign-pkg <appOutDir>`（写 VMP `.sig` 到 framework 旁；必须在 codesign 封包前，否则失效）。
4. electron-builder 自动 Apple codesign（Developer ID + Hardened Runtime + Widevine 权限 plist），把 `.sig` 封进签名。
5. 公证 + staple（`mac.notarize`，App Store Connect API key）。Hardened Runtime 是公证前提。
6. **Windows**（若上 Widevine）：反过来——`afterSign` 里、Authenticode 签名**之后**跑 vmp sign-pkg。
7. **Linux**：不需 VMP 签名，运行时下 CDM。

**electron-builder.yml 需补**：
- `afterPack: ./build/hooks/afterPack.js`（darwin 跑 vmp sign-pkg）、`afterSign: ./build/hooks/afterSign.js`（win32）。可从 Flow `build/hooks/*` 近乎照搬。
- `mac.hardenedRuntime: true`、`mac.entitlements` / `entitlementsInherit: build/entitlements.mac.plist`、`mac.notarize: true`。
- **新建 `build/entitlements.mac.plist`**，最小集：
  - `com.apple.security.cs.disable-library-validation`（**必需**：加载非 Apple 签名的 Widevine CDM dylib；onething 自己的 asar.unpacked 原生模块 better-sqlite3/node-pty/sherpa/macos-panel 也靠它）
  - `com.apple.security.cs.allow-unsigned-executable-memory`
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-dyld-environment-variables`
  - `com.apple.security.device.audio-input`（沿用现有麦克风需求）
  - **不要**加 `app-sandbox`（Widevine 在沙箱/MAS 下不工作）。
- CI（`.github/workflows/build.yml` 现在是裸 `electron-builder --mac` 无签名）：加 EVS 安装+认证步骤，传 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_API_KEY(_ID/_ISSUER)`。

**参照实现**：Flow `build/hooks/{afterPack,afterSign}.js`、`build/hooks/components/castlabs-evs.js`、`build/entitlements.mac.plist`、`electron-builder.ts`、`.github/workflows/build-and-release.yml`、`docs/contributing/updating-electron.md`。
