/**
 * UA 最小洗 + app ready 前的 Chromium 开关。
 *
 * ## 这只文件的全部价值是一条**反直觉**的根因(2026-07-26 用户亲测)
 *
 * 内嵌 Chromium 想登谷歌,唯一要做的 UA 改动是**删掉 ` Electron/<ver>` 这一个
 * token**,别的一个字都不许动 —— app 自己那个产品 token(`onething/x.y.z`)留着,
 * 完整的 Chromium 构建号(`Chrome/146.0.7680.166`)也留着。
 *
 * 直觉会说「洗得越干净越像真 Chrome」,而实测相反:把版本号抹成 `<major>.0.0.0`、
 * 把 app token 删掉的那种「干净」UA,**反而**被谷歌的登录环境检查判成假的,弹
 * 「this browser or app may not be secure」。最小洗出来的串与本机那台能登的
 * Flow Browser 逐字同形。这条判据在 07-26 被发现**之前**做过一次「官方 Electron
 * 登不上」的实验,所以那次实验不算数(方案 §1.3-①:官方核 + 修正后的配方是 B0-①
 * 要真机走的三阶实验,不是一句承诺)。
 *
 * `Sec-CH-UA` 仍然会说 "Chromium" —— 那没关系,Flow 发的也是它,谷歌不按
 * "Google Chrome" 这个 brand 卡人。要把 `Sec-CH-UA-*` 也弄成真 Chrome 是 B0-①
 * 第二阶(CDP `Network.setUserAgentOverride` 带完整 `userAgentMetadata`),
 * 不在本单。
 *
 * ## 零 electron import
 *
 * 两个函数都收**结构化的端口**而不是 `import { app } from 'electron'` —— 于是
 * 它们在 vitest(node,没有 Electron 运行时)里跑得起来。真正 import electron 的
 * 只有 `index.ts` 那一处(DIP,方案 §9-10 的同一条纪律)。
 */

/** `app.commandLine` 那一小片。名字与 Electron 的形一致,所以真 app 直接喂得进来。 */
export interface ChromiumCommandLine {
  appendSwitch(name: string, value?: string): void
  hasSwitch(name: string): boolean
}

export interface ChromiumApp {
  readonly commandLine: ChromiumCommandLine
}

/** 被删掉的那一个 token。抽成常量是为了测试能对着同一份判据断言。 */
const ELECTRON_TOKEN = /\sElectron\/\S+/

/**
 * UA 策略。做成类而不是一个自由函数,是因为 B0-① 第二阶要在它旁边长出
 * `userAgentMetadata`(brands / fullVersionList / platform)那一份 —— 那时它仍然是
 * 「这台浏览器对外自称什么」这一件事,只是多了一个面,不该散成两个模块。
 */
export class UserAgentPolicy {
  /**
   * 洗一次 UA。**只删一个 token**,见文件头。
   *
   * 幂等:已经洗过的串里没有那个 token,再洗一次原样返回。
   */
  apply(defaultUserAgent: string): string {
    return defaultUserAgent.replace(ELECTRON_TOKEN, '')
  }
}

/** 单例够用 —— 它没有状态。 */
export const userAgentPolicy = new UserAgentPolicy()

let flagsApplied = false

/**
 * 内嵌浏览器要的 Chromium 开关。**必须在 app `ready` 之前**调
 * (`appendSwitch` 之后 Chromium 才读命令行)。幂等。
 *
 * FedCM 在 Electron 里是坏的,而且**它存在本身**就会绊倒谷歌的登录环境检查。
 * 关掉它是那份已验配方的第二件(第一件是上面的 UA)。
 *
 * 开关名带不带 `--` 前缀都行 —— Chromium 的 `CommandLine::AppendSwitchNative`
 * 会先 `GetSwitchPrefixLength` 把前缀剥掉。这里**逐字沿用**那份验过的写法
 * (旧壳 `chromium-flags.ts`),不为「更规范」去动一份已经被真机证明过的字符串。
 */
export function applyChromiumFlags(app: ChromiumApp): void {
  if (flagsApplied) return
  flagsApplied = true
  app.commandLine.appendSwitch('--disable-features', 'FedCm')
}

/** 测试缝:同一个进程里连跑两例时把幂等闩复位。 */
export function resetChromiumFlagsForTests(): void {
  flagsApplied = false
}
