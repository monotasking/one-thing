import { describe, expect, it } from 'vitest'
import {
  PLUGIN_WEBVIEW_DEFAULT_ROOT,
  buildPluginWebviewCsp,
  describePluginWebviewPanelProblem,
  describePluginWebviewRootProblem,
  isPluginWebviewPanel,
  pluginWebviewEntryUrl,
  pluginWebviewMimeType,
  resolvePluginWebviewRequestSegments,
  resolvePluginWebviewRoot,
} from '../webview.js'
import { PLUGIN_IMAGE_URL_PATTERN, PLUGIN_LINK_URL_PATTERN } from '../panel.js'

describe('webview panel declaration', () => {
  it('缺省是描述树面板 —— 老 manifest 一个字不用改', () => {
    expect(describePluginWebviewPanelProblem({ id: 'a' })).toBeNull()
    expect(isPluginWebviewPanel({ id: 'a' })).toBe(false)
    expect(describePluginWebviewPanelProblem({ id: 'a', view: 'descriptor' })).toBeNull()
  })

  it('合法的 webview 声明', () => {
    expect(describePluginWebviewPanelProblem({ id: 'a', view: 'webview', entry: 'index.html' })).toBeNull()
    expect(describePluginWebviewPanelProblem(
      { id: 'a', view: 'webview', entry: 'ui/index.html' },
      'dist',
    )).toBeNull()
    expect(isPluginWebviewPanel({ id: 'a', view: 'webview', entry: 'index.html' })).toBe(true)
  })

  it.each([
    ['缺 entry', { id: 'a', view: 'webview' }],
    ['entry 是绝对路径', { id: 'a', view: 'webview', entry: '/etc/passwd.html' }],
    ['entry 有 ..', { id: 'a', view: 'webview', entry: '../secret.html' }],
    ['entry 藏在中段的 ..', { id: 'a', view: 'webview', entry: 'ui/../../secret.html' }],
    ['javascript: 伪装成 html', { id: 'a', view: 'webview', entry: 'javascript:alert(1).html' }],
    ['data: 伪装成 html', { id: 'a', view: 'webview', entry: 'data:text/html,x.html' }],
    ['编码变体', { id: 'a', view: 'webview', entry: '%2e%2e/secret.html' }],
    ['反斜杠', { id: 'a', view: 'webview', entry: 'ui\\index.html' }],
    ['不是 html', { id: 'a', view: 'webview', entry: 'index.js' }],
    ['空 entry', { id: 'a', view: 'webview', entry: '' }],
    ['不认识的 view', { id: 'a', view: 'native', entry: 'index.html' }],
    ['描述树面板带 entry', { id: 'a', entry: 'index.html' }],
  ])('拒绝:%s', (_label, panel) => {
    expect(describePluginWebviewPanelProblem(panel)).toBeTruthy()
  })

  it('静态根非法 = 这个插件的全部 webview 面板被丢弃', () => {
    expect(describePluginWebviewRootProblem(undefined)).toBeNull()
    expect(describePluginWebviewRootProblem('webview')).toBeNull()
    expect(describePluginWebviewRootProblem('build/ui')).toBeNull()
    expect(describePluginWebviewRootProblem('../..')).toBeTruthy()
    expect(describePluginWebviewRootProblem('/abs')).toBeTruthy()
    expect(describePluginWebviewRootProblem('')).toBeTruthy()
    expect(describePluginWebviewPanelProblem(
      { id: 'a', view: 'webview', entry: 'index.html' },
      '../escape',
    )).toBeTruthy()
  })

  it('缺省静态根是 webview/', () => {
    expect(resolvePluginWebviewRoot(undefined)).toBe(PLUGIN_WEBVIEW_DEFAULT_ROOT)
    expect(resolvePluginWebviewRoot('')).toBe(PLUGIN_WEBVIEW_DEFAULT_ROOT)
    expect(resolvePluginWebviewRoot('dist')).toBe('dist')
  })
})

describe('webview 协议路径规范化', () => {
  it('正常路径', () => {
    expect(resolvePluginWebviewRequestSegments('/index.html')).toEqual(['index.html'])
    expect(resolvePluginWebviewRequestSegments('/ui/app.js')).toEqual(['ui', 'app.js'])
    expect(resolvePluginWebviewRequestSegments('/./ui//app.js')).toEqual(['ui', 'app.js'])
    // 名字里带连字符/点是完全正常的资源名 —— 别把它们一起挡掉。
    expect(resolvePluginWebviewRequestSegments('/my-app.v2.css')).toEqual(['my-app.v2.css'])
  })

  it.each([
    ['目录请求', '/'],
    ['空', ''],
    ['穿越', '/../secret'],
    ['中段穿越', '/ui/../../secret'],
    ['纯 ..', '/..'],
    ['反斜杠', '/ui\\..\\secret'],
  ])('拒绝:%s', (_label, input) => {
    expect(resolvePluginWebviewRequestSegments(input)).toBeNull()
  })

  it('NUL 截断被拒', () => {
    expect(resolvePluginWebviewRequestSegments(`/index.html${String.fromCharCode(0)}.png`)).toBeNull()
  })

  it('编码变体在解码之后才判 —— 这正是判据吃"已解码路径"的理由', () => {
    // 调用方(协议 handler)先 decodeURIComponent,于是 %2e%2e 在这里已经是 ..
    expect(resolvePluginWebviewRequestSegments(decodeURIComponent('/%2e%2e/secret'))).toBeNull()
    expect(resolvePluginWebviewRequestSegments(decodeURIComponent('/ui/%2e%2e/%2e%2e/secret'))).toBeNull()
  })
})

describe('MIME 白名单', () => {
  it.each(['index.html', 'app.js', 'app.mjs', 'style.css', 'data.json', 'a.svg', 'a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.woff2'])(
    '放行 %s',
    name => expect(pluginWebviewMimeType(name)).toBeTruthy(),
  )

  it.each(['native.node', 'run.sh', '.env', 'plugin.json.bak', 'noext', 'a.exe', 'a.wasm'])(
    '拒绝 %s',
    name => expect(pluginWebviewMimeType(name)).toBeNull(),
  )
})

describe('CSP', () => {
  it('按插件 origin 钉死,且不给出网', () => {
    const csp = buildPluginWebviewCsp('demo')
    expect(csp).toContain("default-src 'none'")
    // 实测两种写法都放行(见 §6.3);两条都写,host-source 是不依赖实现细节的那条。
    expect(csp).toContain("script-src 'self' onething-plugin://demo")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    // 别的插件的 origin 不在里面。
    expect(csp).not.toContain('onething-plugin://other')
  })
})

describe('描述树里的 onething-plugin: scheme', () => {
  it('image 放行,link 不放行', () => {
    expect(PLUGIN_IMAGE_URL_PATTERN.test('onething-plugin://demo/logo.png')).toBe(true)
    expect(PLUGIN_LINK_URL_PATTERN.test('onething-plugin://demo/page.html')).toBe(false)
    expect(PLUGIN_IMAGE_URL_PATTERN.test('http://x/a.png')).toBe(false)
    expect(PLUGIN_IMAGE_URL_PATTERN.test('javascript:alert(1)')).toBe(false)
  })

  it('entry url 拼装', () => {
    expect(pluginWebviewEntryUrl('demo', 'index.html')).toBe('onething-plugin://demo/index.html')
    expect(pluginWebviewEntryUrl('demo', '/index.html')).toBe('onething-plugin://demo/index.html')
  })
})
