/**
 * G 期验收(L2.5):`contributes.theme.background` 背景/材质层。
 *
 * 钉住的东西:
 *  1. **安全面复用 C 期** —— 图路径的判据就是 webview entry 那一份(相对、无 `..`、
 *     无 scheme/编码变体),只在扩展名白名单上分叉。路径穿越、绝对路径、
 *     `javascript:`、`%2e%2e`、坏扩展名逐条反例。
 *  2. **越界数值:声明拒、运行期钳** —— 有意的不对称,理由见 background.ts。
 *  3. **裁决与 token 覆盖同构** —— 全局规范顺序后者胜、停用不参与、非法不拒载
 *     (标 invalid + reason),输入顺序不影响结果。
 *  4. **拆除即撤层** —— 停用/卸载后没有 active 声明,winner 归 null。
 *  5. **updateBackground 的门控** —— 只有 manifest 声明了 background 的插件调得动;
 *     没声明只记一条 error 日志并拒绝,**不计熔断**(一次笔误不该连坐整个插件)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_BACKGROUND_MAX_BLUR,
  clampPluginBackgroundParamsPatch,
  createCorePluginAPI,
  describePluginBackgroundProblem,
  isPluginBackgroundFit,
  mergePluginBackgroundParams,
  pluginBackgroundImageUrl,
  resolvePluginBackgrounds,
  validatePluginContributes,
} from '../index.js'

// ── 1. 声明校验:正反例 ───────────────────────────

describe('describePluginBackgroundProblem', () => {
  it('放行合法声明(含只写 image 的最小形态)', () => {
    expect(describePluginBackgroundProblem(undefined)).toBeNull()
    expect(describePluginBackgroundProblem({ image: 'bg.svg' })).toBeNull()
    expect(describePluginBackgroundProblem({ image: 'assets/bg.png' })).toBeNull()
    expect(describePluginBackgroundProblem({
      image: 'bg.jpg',
      darkImage: 'bg-dark.webp',
      opacity: 0.35,
      blur: 12,
      fit: 'contain',
    })).toBeNull()
    // 边界值本身是合法的。
    expect(describePluginBackgroundProblem({ image: 'a.gif', opacity: 0, blur: 0 })).toBeNull()
    expect(describePluginBackgroundProblem({
      image: 'a.jpeg',
      opacity: 1,
      blur: PLUGIN_BACKGROUND_MAX_BLUR,
    })).toBeNull()
  })

  it('路径穿越 / 绝对路径 / scheme / 编码变体全拒 —— 判据与 webview entry 同一份', () => {
    for (const image of [
      '../../../.ssh/id_rsa.png',
      '..%2f..%2fsecret.png',
      'a/../../b.png',
      '/etc/passwd.png',
      'file:///etc/passwd.png',
      'https://tracker.example/pixel.png',
      'javascript:alert(1).png',
      'data:image/png;base64,AAAA',
      'a\\b.png',
      'a?x=1.png',
      'a#frag.png',
      'a//b.png',
      './bg.png',
      'C:\\bg.png',
    ]) {
      expect(describePluginBackgroundProblem({ image }), image).not.toBeNull()
    }
  })

  it('坏扩展名全拒(白名单是图片,不是 webview 的那一张 MIME 全表)', () => {
    for (const image of ['bg.html', 'bg.js', 'bg.css', 'bg.json', 'bg.woff2', 'bg', 'bg.PNG.exe']) {
      expect(describePluginBackgroundProblem({ image }), image).not.toBeNull()
    }
    // 大小写不敏感 —— 扩展名比对前先小写。
    expect(describePluginBackgroundProblem({ image: 'BG.PNG' })).toBeNull()
  })

  it('darkImage 走同一套判据', () => {
    expect(describePluginBackgroundProblem({ image: 'a.png', darkImage: '../b.png' })).not.toBeNull()
    expect(describePluginBackgroundProblem({ image: 'a.png', darkImage: 'b.html' })).not.toBeNull()
  })

  it('越界数值 / 坏类型 / 未知 fit 全拒(声明是作者写死的,说出来才有人改)', () => {
    for (const background of [
      { image: 'a.png', opacity: -0.1 },
      { image: 'a.png', opacity: 1.5 },
      { image: 'a.png', opacity: Number.NaN },
      { image: 'a.png', opacity: Number.POSITIVE_INFINITY },
      { image: 'a.png', opacity: '0.5' },
      { image: 'a.png', blur: -1 },
      { image: 'a.png', blur: PLUGIN_BACKGROUND_MAX_BLUR + 1 },
      { image: 'a.png', blur: '10' },
      { image: 'a.png', fit: 'stretch' },
      { image: 'a.png', fit: 'COVER' },
      { image: 'a.png', fit: 1 },
      { image: '' },
      { image: 42 },
      {},
      'bg.png',
      [],
    ]) {
      expect(describePluginBackgroundProblem(background), JSON.stringify(background)).not.toBeNull()
    }
  })

  it('非法背景不是加载期错误 —— 与未知锚点、token 覆盖同规:降级不拒载', () => {
    expect(validatePluginContributes({ theme: { background: { image: '../x.png' } } })).toBeNull()
    expect(validatePluginContributes({ theme: { background: 'nope' } })).toBeNull()
    // 只声明 background、一个 token 都不覆盖也是合法的。
    expect(validatePluginContributes({ theme: { background: { image: 'bg.png' } } })).toBeNull()
  })

  it('fit 白名单', () => {
    expect(isPluginBackgroundFit('cover')).toBe(true)
    expect(isPluginBackgroundFit('contain')).toBe(true)
    expect(isPluginBackgroundFit('tile')).toBe(true)
    for (const value of ['fill', 'none', '', 'Cover', null, undefined, 1]) {
      expect(isPluginBackgroundFit(value), String(value)).toBe(false)
    }
  })
})

// ── 2. 运行期补丁:钳制而不是拒绝 ─────────────────

describe('clampPluginBackgroundParamsPatch', () => {
  it('越界数字钳进区间(用户拖滑杆不该把控件卡住)', () => {
    expect(clampPluginBackgroundParamsPatch({ opacity: 5 })).toEqual({ opacity: 1 })
    expect(clampPluginBackgroundParamsPatch({ opacity: -3 })).toEqual({ opacity: 0 })
    expect(clampPluginBackgroundParamsPatch({ blur: 999 })).toEqual({ blur: PLUGIN_BACKGROUND_MAX_BLUR })
    expect(clampPluginBackgroundParamsPatch({ blur: -20 })).toEqual({ blur: 0 })
  })

  it('坏类型 / 未知 fit 被忽略(保留上一次的值),image 永远不看', () => {
    expect(clampPluginBackgroundParamsPatch({ opacity: '0.5', blur: null, fit: 'stretch' })).toEqual({})
    expect(clampPluginBackgroundParamsPatch({ opacity: Number.NaN })).toEqual({})
    expect(clampPluginBackgroundParamsPatch({ image: 'evil.png', fit: 'tile' })).toEqual({ fit: 'tile' })
    expect(clampPluginBackgroundParamsPatch(null)).toEqual({})
    expect(clampPluginBackgroundParamsPatch('cover')).toEqual({})
  })

  it('manifest 缺省 ⊕ 最新 update —— 补丁只盖它给出的那几个字段', () => {
    const declaration = { image: 'a.png', opacity: 0.4, blur: 6, fit: 'contain' as const }
    expect(mergePluginBackgroundParams(declaration, {}))
      .toEqual({ opacity: 0.4, blur: 6, fit: 'contain' })
    expect(mergePluginBackgroundParams(declaration, { opacity: 0.9 }))
      .toEqual({ opacity: 0.9, blur: 6, fit: 'contain' })
    // 没声明的项落到宿主缺省,而不是 undefined。
    expect(mergePluginBackgroundParams({ image: 'a.png' }, null))
      .toEqual({ opacity: 1, blur: 0, fit: 'cover' })
  })
})

// ── 3. 裁决:后者胜 / 停用不参与 / 非法标记 ──────

describe('resolvePluginBackgrounds', () => {
  const input = (pluginId: string, background: unknown, enabled = true) =>
    ({ pluginId, enabled, background })

  it('多插件都声明时按全局规范顺序后者胜,输入顺序不影响结果', () => {
    const forward = resolvePluginBackgrounds([
      input('alpha', { image: 'a.png' }),
      input('zed', { image: 'z.png' }),
    ])
    const reversed = resolvePluginBackgrounds([
      input('zed', { image: 'z.png' }),
      input('alpha', { image: 'a.png' }),
    ])
    expect(forward.winner?.pluginId).toBe('zed')
    expect(reversed.winner?.pluginId).toBe('zed')
    expect(forward.byPlugin.get('alpha')?.status).toBe('shadowed')
    expect(forward.byPlugin.get('alpha')?.shadowedBy).toBe('zed')
    expect(forward.byPlugin.get('zed')?.status).toBe('active')
  })

  it('停用的插件声明可见但不参与裁决 —— 关掉一个插件不该改变另一个的状态', () => {
    const resolution = resolvePluginBackgrounds([
      input('alpha', { image: 'a.png' }),
      input('zed', { image: 'z.png' }, false),
    ])
    expect(resolution.byPlugin.get('zed')?.status).toBe('inactive')
    expect(resolution.byPlugin.get('alpha')?.status).toBe('active')
    expect(resolution.winner?.pluginId).toBe('alpha')
  })

  it('拆除即撤层:全停用之后没有赢家', () => {
    const resolution = resolvePluginBackgrounds([
      input('alpha', { image: 'a.png' }, false),
      input('zed', { image: 'z.png' }, false),
    ])
    expect(resolution.winner).toBeNull()
    // 卸载 = 它根本不在清单里,连条目都没有。
    expect(resolvePluginBackgrounds([]).winner).toBeNull()
  })

  it('非法声明标 invalid + reason,而且不参与裁决(合法的那一条照样赢)', () => {
    const resolution = resolvePluginBackgrounds([
      input('alpha', { image: 'a.png' }),
      input('zed', { image: '../../etc/passwd.png' }),
    ])
    expect(resolution.byPlugin.get('zed')?.status).toBe('invalid')
    expect(resolution.byPlugin.get('zed')?.reason).toContain('..')
    expect(resolution.winner?.pluginId).toBe('alpha')
  })

  it('没声明背景的插件不进表', () => {
    const resolution = resolvePluginBackgrounds([input('alpha', undefined)])
    expect(resolution.byPlugin.has('alpha')).toBe(false)
    expect(resolution.winner).toBeNull()
  })

  it('赢家带完整 onething-plugin:// URL;没声明 darkImage 时深色图回填成同一张', () => {
    const withDark = resolvePluginBackgrounds([
      input('ink-brand', { image: 'bg.svg', darkImage: 'bg-dark.svg', opacity: 0.35, fit: 'tile' }),
    ])
    expect(withDark.winner).toEqual({
      pluginId: 'ink-brand',
      imageUrl: 'onething-plugin://ink-brand/bg.svg',
      darkImageUrl: 'onething-plugin://ink-brand/bg-dark.svg',
      opacity: 0.35,
      blur: 0,
      fit: 'tile',
    })
    const withoutDark = resolvePluginBackgrounds([input('ink-brand', { image: 'bg.svg' })])
    expect(withoutDark.winner?.darkImageUrl).toBe('onething-plugin://ink-brand/bg.svg')
    // URL 与 webview entry 同一个出处 —— 路径相对静态根,不带根那一段。
    expect(pluginBackgroundImageUrl('ink-brand', 'bg.svg')).toBe('onething-plugin://ink-brand/bg.svg')
  })

  it('运行期参数合进赢家(manifest 缺省 ⊕ 最新 update),并且照样钳制', () => {
    const resolution = resolvePluginBackgrounds([{
      pluginId: 'ink-brand',
      enabled: true,
      background: { image: 'bg.svg', opacity: 0.35 },
      runtimeParams: { opacity: 5, blur: 12 },
    }])
    expect(resolution.winner?.opacity).toBe(1)
    expect(resolution.winner?.blur).toBe(12)
  })

  /*
   * 恢复默认闭环(2026-08-10)。运行期图接管了 darkImage 的语义,撤回必须把
   * 那一步**对称地**还回去 —— 只还浅色图、深色仍是空,等于把"恢复默认"做成半张。
   */
  it('image: null 撤回运行期图 —— 回落 manifest 缺省图,darkImage 一并恢复', () => {
    const background = { image: 'bg.png', darkImage: 'bg-dark.png' }
    const taken = resolvePluginBackgrounds([{
      pluginId: 'ink-brand',
      enabled: true,
      background,
      runtimeParams: { image: 'storage:imports/paper.png' },
    }])
    // 先钉住"接管"这一半:运行期图赢,深色被它一起接管。
    expect(taken.winner?.imageUrl).toBe('onething-plugin://ink-brand/__storage__/imports/paper.png')
    expect(taken.winner?.darkImageUrl).toBe('onething-plugin://ink-brand/__storage__/imports/paper.png')

    const cleared = resolvePluginBackgrounds([{
      pluginId: 'ink-brand',
      enabled: true,
      background,
      // 内存态是合并存的:撤回以 null 的样子躺在这里,不是键被删掉。
      runtimeParams: { image: null, opacity: 0.5 },
    }])
    expect(cleared.byPlugin.get('ink-brand')?.image).toBe('bg.png')
    expect(cleared.byPlugin.get('ink-brand')?.darkImage).toBe('bg-dark.png')
    expect(cleared.winner?.imageUrl).toBe('onething-plugin://ink-brand/bg.png')
    expect(cleared.winner?.darkImageUrl).toBe('onething-plugin://ink-brand/bg-dark.png')
    // 撤图不撤旋钮:null 只说了 image 这一格。
    expect(cleared.winner?.opacity).toBe(0.5)
  })

  it('image: undefined 不动 image —— 半条补丁与 opacity 同规', () => {
    const resolution = resolvePluginBackgrounds([{
      pluginId: 'ink-brand',
      enabled: true,
      background: { image: 'bg.png', darkImage: 'bg-dark.png' },
      runtimeParams: { image: undefined, blur: 4 },
    }])
    expect(resolution.winner?.imageUrl).toBe('onething-plugin://ink-brand/bg.png')
    expect(resolution.winner?.darkImageUrl).toBe('onething-plugin://ink-brand/bg-dark.png')
    expect(resolution.winner?.blur).toBe(4)
  })

  it('clamp 保得住 null —— 丢了这个键,合并时上一张图会继续赢', () => {
    expect(clampPluginBackgroundParamsPatch({ image: null })).toEqual({ image: null })
    expect(clampPluginBackgroundParamsPatch({ image: undefined, blur: 3 })).toEqual({ blur: 3 })
  })
})

// ── 4. api.theme.updateBackground:门控与钳制 ─────

function createApi(options: { declaredBackground?: boolean } = {}) {
  const updatePluginBackground = vi.fn()
  const onPluginFailure = vi.fn()
  const error = vi.fn()
  const created = (createCorePluginAPI as any)({
    pluginId: 'demo',
    declaredBackground: options.declaredBackground,
    scheduler: { schedule: () => {}, cancel: () => {} },
    store: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] },
    host: { updatePluginBackground },
    logger: { log: () => {}, error },
    onPluginFailure,
  })
  return { api: created.api as any, state: created.state, updatePluginBackground, onPluginFailure, error }
}

describe('api.theme.updateBackground', () => {
  it('声明先于代码:manifest 没声明 background 就调不动', () => {
    const { api, updatePluginBackground, onPluginFailure, error } = createApi()
    api.theme.updateBackground({ opacity: 0.5 })
    expect(updatePluginBackground).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    // **不计熔断**:一次笔误不该连坐整个插件,而这条调用本身没有任何副作用。
    expect(onPluginFailure).not.toHaveBeenCalled()
  })

  it('声明了就能调,值经钳制后落到宿主', () => {
    const { api, updatePluginBackground } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ opacity: 5, blur: 999, fit: 'tile' })
    expect(updatePluginBackground).toHaveBeenCalledWith('demo', {
      opacity: 1,
      blur: PLUGIN_BACKGROUND_MAX_BLUR,
      fit: 'tile',
    })
  })

  /*
   * B 期(用户壁纸)改了这一条的形状,没有改它的立意。
   *
   * 从前:`image` 整个字段被无视 —— 换图只能发新版本。
   * 现在:**包内**换图仍然只能发新版本(下面第二条),多出来的是
   * `storage:` 那一格 —— 用户经 file-pick 导进来的图,插件只拿到地址。
   *
   * 非法图源从"丢一个字段"改成"拒整条调用":插件明说了"把背景换成这张",
   * 只把透明度改掉、图还是老的那一张,比什么也不做更难解释。
   */
  it('包内路径换图仍然被拒,并且拒的是整条调用(不是丢一个字段)', () => {
    const { api, updatePluginBackground, onPluginFailure, error } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ image: '../../etc/passwd.png', opacity: 0.5 } as never)
    expect(updatePluginBackground).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    // 与未声明 background 同规:作者写错寻址,不开熔断面。
    expect(onPluginFailure).not.toHaveBeenCalled()

    api.theme.updateBackground({ image: 'bg/paper.png' } as never)
    expect(updatePluginBackground).not.toHaveBeenCalled()
  })

  it('storage: 寻址的图可以运行期换 —— 那是用户自己导进来的那张', () => {
    const { api, updatePluginBackground } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ image: 'storage:imports/paper.png', opacity: 0.5 } as never)
    expect(updatePluginBackground).toHaveBeenCalledWith('demo', {
      image: 'storage:imports/paper.png',
      opacity: 0.5,
    })
  })

  /*
   * 恢复默认闭环(2026-08-10):`null` 是**撤回**,不是一个坏图源。
   * 它不进图源门 —— 那道门判的是"这张图能不能当背景",而这里根本没有图。
   */
  it('image: null 放行(不过图源校验、不记 error、照样广播)', () => {
    const { api, updatePluginBackground, onPluginFailure, error } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ image: null } as never)
    expect(updatePluginBackground).toHaveBeenCalledWith('demo', { image: null })
    expect(error).not.toHaveBeenCalled()
    expect(onPluginFailure).not.toHaveBeenCalled()
  })

  it('image: null 单独成一条补丁也算"说了话" —— 不被空补丁闸吞掉', () => {
    const { api, updatePluginBackground } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ image: null, opacity: 'x' } as never)
    expect(updatePluginBackground).toHaveBeenCalledWith('demo', { image: null })
  })

  it('image: undefined 仍然是"这次不动 image"(与 null 不能合流)', () => {
    const { api, updatePluginBackground } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ image: undefined, opacity: 0.5 } as never)
    expect(updatePluginBackground).toHaveBeenCalledWith('demo', { opacity: 0.5 })
  })

  it('全是非法值 = 什么也没说,不广播', () => {
    const { api, updatePluginBackground } = createApi({ declaredBackground: true })
    api.theme.updateBackground({ opacity: 'x', fit: 'stretch' } as never)
    expect(updatePluginBackground).not.toHaveBeenCalled()
  })

  it('拆除之后再调是 no-op(层已经撤了,写参数没有落点)', () => {
    const { api, state, updatePluginBackground } = createApi({ declaredBackground: true })
    ;(state as { disposed: boolean }).disposed = true
    api.theme.updateBackground({ opacity: 0.2 })
    expect(updatePluginBackground).not.toHaveBeenCalled()
  })
})
