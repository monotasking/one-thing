/**
 * `scripts/lib/search-corpus-redact.mjs` 的用例(检索重建 S0)。
 *
 * 八条规则**逐条**一组:一句「脏的」进去,断言换成了什么、`findRedactionHits` 认得出
 * 脏的、洗过之后认不出。最后一组守的是整份文件唯一的验收判据 —— **幂等**:洗两遍与
 * 洗一遍逐字相同。夹具自检(`packages/core/search/__tests__/fixtures.test.ts`)在成品
 * 语料上跑的就是同一句话。
 *
 * 规则 8(`public-ipv4`)另有一节:它是唯一带 `accept` 谓词的规则,所以「形状命中」
 * 与「真要洗」是两件事,两边都得逐条守 —— 公网的洗掉、私网与文档段留住、版本号别
 * 误伤。留住的那些同样要过「洗过之后零命中」,不然幂等那条恒等式在成品语料上当场红。
 */
import { describe, expect, it } from 'vitest'
import { REDACT_RULE_IDS, findRedactionHits, redactText } from '../lib/search-corpus-redact.mjs'

/** 每条规则一组「脏样本 → 洗完长什么样」。 */
const CASES = [
  {
    rule: 'home-path',
    dirty: '日志在 /Users/someone/.onething/log/app.jsonl 里,另一台是 /home/deploy/srv/x.log',
    clean: '日志在 ~/.onething/log/app.jsonl 里,另一台是 ~/srv/x.log',
  },
  {
    rule: 'email',
    dirty: '发到 alice.wong+ci@example.co.uk 就行',
    clean: '发到 <redacted:email> 就行',
  },
  {
    rule: 'sk-key',
    dirty: '把 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv 填进去',
    clean: '把 <redacted:apikey> 填进去',
  },
  {
    rule: 'bearer',
    dirty: 'curl -H "Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.abc-def_123"',
    clean: 'curl -H "Authorization: Bearer <redacted:token>"',
  },
  {
    rule: 'assigned-secret',
    // 键名与分隔符留住,只换右边 —— 这样语料里「这里配了一个 key」这条信息还在。
    dirty: 'api_key=Zm9vYmFyYmF6cXV4 与 password: "hunter2hunter2"',
    clean: 'api_key=<redacted:secret> 与 password: "<redacted:secret>',
  },
  {
    rule: 'phone',
    dirty: '打 13800138000,或者 +86 139-0013-8001',
    clean: '打 <redacted:phone>,或者 <redacted:phone>',
  },
  {
    rule: 'long-token',
    dirty: '装置 id 是 f647f002c5b84c1b89e49439171815d1aa 这一串',
    clean: '装置 id 是 <redacted:token> 这一串',
  },
  {
    rule: 'public-ipv4',
    // 同一句里两个形状逐字一样的地址:公网那个换掉,内网那个留着 —— 「他们在讨论
    // 内网拓扑」这条信号不该被脱敏顺手洗没。
    dirty: '回源打到 93.184.216.34,内网网关还是 10.62.172.242',
    clean: '回源打到 <ip>,内网网关还是 10.62.172.242',
  },
]

describe('search corpus redaction', () => {
  it('每条规则都在表里', () => {
    expect(REDACT_RULE_IDS).toEqual([
      'home-path',
      'email',
      'sk-key',
      'bearer',
      'assigned-secret',
      'phone',
      'long-token',
      'public-ipv4',
    ])
    expect(CASES.map(c => c.rule)).toEqual(REDACT_RULE_IDS)
  })

  for (const { rule, dirty, clean } of CASES) {
    describe(rule, () => {
      it('洗成预期的样子', () => {
        expect(redactText(dirty)).toBe(clean)
      })

      it('脏样本被这条规则认出来', () => {
        expect(findRedactionHits(dirty)).toContain(rule)
      })

      it('洗过之后没有任何规则再命中', () => {
        expect(findRedactionHits(redactText(dirty))).toEqual([])
      })

      it('洗两遍与洗一遍逐字相同', () => {
        const once = redactText(dirty)
        expect(redactText(once)).toBe(once)
      })
    })
  }

  it('时间戳不是手机号(13 位毫秒时间戳不许被吃)', () => {
    // 真库里满地都是 `timestamp: 1785684318323`;`1[3-9]\d{9}` 没有数字断言就会把
    // 它前 11 位当手机号,语料当场被洗烂。
    expect(redactText('timestamp 1785684318323 结束')).toBe('timestamp 1785684318323 结束')
    expect(findRedactionHits('1785684318323')).toEqual([])
  })

  it('普通中文与短英文一字不动', () => {
    const text = '身份牌已发给女巫,天黑请闭眼。nginx 反向代理 502 了。'
    expect(redactText(text)).toBe(text)
    expect(findRedactionHits(text)).toEqual([])
  })

  it('非字符串原样返回', () => {
    expect(redactText(undefined)).toBe(undefined)
    expect(redactText(42)).toBe(42)
    expect(findRedactionHits(undefined)).toEqual([])
  })

  describe('public-ipv4 的取舍', () => {
    /** 语料里真出现过、且必须洗掉的四条(抽取前逐条数过)。 */
    const PUBLIC = ['42.193.111.28', '93.184.216.34', '149.0.0.0', '47.117.49.30']

    /** 明确要**留住**的:私网 / 保留段 / 公共 DNS / 文档与基准测试段。 */
    const KEPT = [
      // 私网、回环、链路本地、`0/8`。
      '10.62.172.242', '172.16.0.9', '172.31.255.254', '192.168.1.100',
      '127.0.0.1', '127.0.0.53', '169.254.169.254', '0.0.0.0',
      // 首段 ≥ 224:组播与其上的保留段,顺带盖住掩码写法。
      '224.0.0.1', '239.255.255.250', '255.255.255.0', '255.255.255.255',
      // 四条公共 DNS —— 它们是常量,不是谁的地址。
      '8.8.8.8', '8.8.4.4', '1.1.1.1', '114.114.114.114',
      // 文档 / 基准测试专用段。
      '1.2.3.4', '198.18.0.91', '192.0.2.5', '198.51.100.7', '203.0.113.9',
    ]

    it('公网地址整段换成 <ip>', () => {
      for (const ip of PUBLIC) {
        expect(redactText(`打到 ${ip} 上`), ip).toBe('打到 <ip> 上')
        expect(findRedactionHits(ip), ip).toContain('public-ipv4')
      }
    })

    it('私网与保留段一字不动,而且不算漏网', () => {
      for (const ip of KEPT) {
        expect(redactText(`连的是 ${ip}`), ip).toBe(`连的是 ${ip}`)
        // 形状当然命中正则 —— 但 `accept` 摇头,所以「验」那一半也必须放过它,
        // 否则成品语料上「每条规则零命中」永远红。
        expect(findRedactionHits(ip), ip).toEqual([])
      }
    })

    it('`172.16–31` 之外的 172 段是公网,照洗', () => {
      // 私网那一格是 `/12` 不是 `/8`:边界错一位就会把真地址当内网放过去。
      expect(redactText('172.15.0.1 与 172.32.0.1')).toBe('<ip> 与 <ip>')
      expect(redactText('172.16.0.1 与 172.31.0.1')).toBe('172.16.0.1 与 172.31.0.1')
    })

    it('版本号与日期不是 IP', () => {
      // 段数不够(三段)、段数超了(五段)、以及任一段 > 255 —— 三种都不该被认成 IP。
      for (const text of ['v1.2.3', '版本 2.10.4 发布', '2026.09.04', '10.0.0.1.5',
        '999.1.1.1', '1.2.3.999', '256.256.256.256']) {
        expect(redactText(text), text).toBe(text)
        expect(findRedactionHits(text), text).toEqual([])
      }
    })
  })

  describe('long-token 的取舍(S3c:标识符不是密钥)', () => {
    /**
     * **必须放过**的正经标识符 —— 三条都 32 位以上,三条都被 S3c 之前的规则 7 整段
     * 换成 `<redacted:token>`,于是它们的词元(`into` / `only` / `constraints` …)根本
     * 没进倒排,用户搜 `Only`、`into` 就漏。前两条是 parity-B 在真库上跑出来的那两条
     * 红的原文,第三条是 64 位的蛇形串(长度不是判据,这一条钉死这句话)。
     */
    const IDENTIFIERS = [
      'translatesAutoresizingMaskIntoConstraints',
      'elcc_bot_res_signal_buttonOnly_buttonNumber',
      'session_transcript_projection_checkpoint_rebuild_background_task_runner',
    ]

    /**
     * **必须照洗**的真密钥形 —— 32 位以上、无前缀的随机串。三种形各一条:数字散在
     * 串里的混合随机串、带连字符与数字的 UUID、base64 样的一长条。
     * (`sk-…` 有自己的规则 3,不在这里守。)
     */
    const SECRETS = [
      'a8F3kL9qZx2mN7vB4tR1yU6wE0sD5gH8',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'bXlzZWNyZXQxMjM0NTY3ODkwYWJjZGVmZ2hpams',
    ]

    it('驼峰 / 蛇形的正经标识符一字不动,而且不算漏网', () => {
      for (const name of IDENTIFIERS) {
        expect(name.length, name).toBeGreaterThanOrEqual(32)
        expect(redactText(`调用 ${name} 之前`), name).toBe(`调用 ${name} 之前`)
        // 形状当然命中正则 —— 但 `accept` 摇头,所以「验」那一半也必须放过它,
        // 否则成品语料上「每条规则零命中」永远红。
        expect(findRedactionHits(name), name).toEqual([])
      }
    })

    it('标识符的词元还在:洗过之后仍然搜得到 `Only` / `Into`', () => {
      // 这一条守的是这次修的**病**本身,不是修法:词元进不进倒排。
      const dirty = 'parseInt(elcc_bot_res_signal_buttonOnly_buttonNumber, 10)'
        + ' 与 translatesAutoresizingMaskIntoConstraints = false'
      const clean = redactText(dirty)
      expect(clean).toBe(dirty)
      for (const word of ['Only', 'Into', 'buttonNumber', 'Constraints']) {
        expect(clean, word).toContain(word)
      }
    })

    it('32 位以上的随机串照洗', () => {
      for (const secret of SECRETS) {
        expect(redactText(`key 是 ${secret} 完`), secret).toBe('key 是 <redacted:token> 完')
        expect(findRedactionHits(secret), secret).toContain('long-token')
        expect(findRedactionHits(redactText(secret)), secret).toEqual([])
      }
    })

    it('判据是结构不是长度:同样 43 位,标识符留、随机串洗', () => {
      const identifier = 'elcc_bot_res_signal_buttonOnly_buttonNumber'
      const secret = 'x7Qm2Vp9Ld4Rt8Nb1Kw6Zc3Hf5Jy0Gs7Aq2Ue9Ir4T'
      expect(redactText(identifier)).toBe(identifier)
      expect(redactText(secret)).toBe('<redacted:token>')
    })
  })

  it('一句里多条规则一起命中,洗完全干净', () => {
    const dirty = '在 /Users/bob/app 跑,联系 bob@example.com 或 13800138000,'
      + ' token=abcdefgh12345678,key 是 sk-ant-api03-AbCdEfGhIjKlMnOpQr'
    const hits = findRedactionHits(dirty)
    for (const rule of ['home-path', 'email', 'phone', 'assigned-secret', 'sk-key']) {
      expect(hits).toContain(rule)
    }
    expect(findRedactionHits(redactText(dirty))).toEqual([])
  })
})
