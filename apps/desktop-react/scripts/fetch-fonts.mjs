#!/usr/bin/env node
/**
 * 字体抓取脚本 —— 把上游的 woff2 落到 `src/assets/fonts/`,并生成 `fonts.css`。
 *
 * 它**是构建工具,不是构建步骤**:平时不跑,`npm run build` 也不碰它。
 * 只有「换字重 / 换分片范围 / 加一门语言」时手动跑一次
 * (`node scripts/fetch-fonts.mjs src/assets/fonts`),把产物提交进仓。
 * 字体是资产不是依赖:每次构建都去问网要,等于把「离线可用」这条又丢回去。
 *
 * 之所以进仓而不是留在临时目录:`fonts.css` 的文件头写着「这份是生成物,
 * 要改就改抓取脚本再跑一次」—— 那句话得指得到一个真实存在的文件。
 */
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const OUT = path.resolve(process.argv[2])
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Noto Sans SC 的 CJK 分片按**使用频次**编号,越大越常用(119 = latin+标点+最常用汉字)。 */
const CJK_KEEP_FROM = 100

const FAMILIES = [
  {
    name: 'Schibsted Grotesk',
    slug: 'schibsted-grotesk',
    url: 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap',
    keepNamed: ['latin', 'latin-ext'],
  },
  {
    name: 'JetBrains Mono',
    slug: 'jetbrains-mono',
    url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap',
    keepNamed: ['latin', 'latin-ext'],
  },
  {
    name: 'Noto Sans SC',
    slug: 'noto-sans-sc',
    url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap',
    keepNamed: ['latin', 'latin-ext'],
    cjkFrom: CJK_KEEP_FROM,
  },
]

async function css(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } })
  if (!r.ok) throw new Error(`css2 HTTP ${r.status} for ${url}`)
  return r.text()
}

/** 带注释的(latin/cyrillic/…)与不带注释的(CJK 分片)两种形状都要认。 */
function parse(sheet) {
  const out = []
  let cursor = 0
  for (const block of sheet.split('@font-face').slice(1)) {
    const start = sheet.indexOf(block, cursor)
    cursor = start + block.length
    const before = sheet.slice(Math.max(0, start - 400), start)
    const comments = before.match(/\/\*\s*([^*]+?)\s*\*\//g) ?? []
    const named = comments.length
      ? comments[comments.length - 1].replace(/[/*]/g, '').trim()
      : ''
    const weight = (block.match(/font-weight:\s*(\d+)/) ?? [])[1]
    const url = (block.match(/url\((https:[^)]+)\)/) ?? [])[1]
    const range = (block.match(/unicode-range:\s*([^;]+);/) ?? [])[1] ?? ''
    if (!weight || !url) continue
    const sliceIdx = Number((url.match(/\.(\d+)\.woff2$/) ?? [])[1])
    out.push({ named, weight, url, range, sliceIdx: Number.isFinite(sliceIdx) ? sliceIdx : null })
  }
  return out
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const rules = []
  let files = 0
  let bytes = 0

  for (const fam of FAMILIES) {
    const faces = parse(await css(fam.url))
    const kept = faces.filter((f) => {
      if (fam.cjkFrom != null && f.sliceIdx != null && !f.named) return f.sliceIdx >= fam.cjkFrom
      return fam.keepNamed.includes(f.named)
    })
    console.log(`${fam.name}: ${faces.length} faces upstream → keep ${kept.length}`)

    // 上游对同一个 (家族, 分片) 的**每个字重给的是同一个 URL** —— 那是一支
    // 可变字体(wght 轴),@font-face 里的 font-weight 只是把它钉在某个实例上。
    // 所以按 URL 去重:26 个文件服务 78 条规则,文件名里也就不带字重。
    const seen = new Map()
    for (const face of kept) {
      const tag = face.named || `cjk-${face.sliceIdx}`
      let file = seen.get(face.url)
      if (!file) {
        file = `${fam.slug}-${tag}.woff2`
        const buf = Buffer.from(await (await fetch(face.url, { headers: { 'user-agent': UA } })).arrayBuffer())
        await writeFile(path.join(OUT, file), buf)
        seen.set(face.url, file)
        files += 1
        bytes += buf.length
      }
      rules.push({ family: fam.name, weight: face.weight, file, range: face.range, tag })
    }
    console.log(`  → ${seen.size} 个唯一文件服务 ${kept.length} 条 @font-face(可变字体,字重共用一支)`)
  }

  const header = `/**
 * 本地字体门面 —— **构建产物离线可用**:index.html 里那条外部字体 <link> 已经删掉,
 * 这些 woff2 随 dist 一起走(\`npm run verify\` 里有一条 grep 钉死这件事)。
 *
 * ── 取舍(工程卫生批 ④)────────────────────────────────────────────────
 * · Schibsted Grotesk 400/500/600/700、JetBrains Mono 400/500:
 *   只留 latin + latin-ext。西里尔 / 希腊 / 越南语分片全丢 —— 这块壳的界面语言
 *   只有中英两门(src/i18n),等哪天真加了再补那几片。
 * · Noto Sans SC 400/500/700:上游把 CJK 切成 101 片,**按使用频次编号,越大越常用**
 *   (119 = latin+标点+最常用汉字)。这里只留 100–119 这 20 片 =
 *   **3441 个最常用汉字**,与 GB/T 2312 一级字(3755)基本同一档。
 *   代价:更冷僻的字(生僻姓名、古文)落到回退栈的系统中文字体(PingFang SC /
 *   微软雅黑),字形换一档而不是画豆腐块 —— 这正是 tokens.css 里那条全回退栈
 *   必须原样保留的理由。
 *   收益:unicode-range 让浏览器**按需**取片,一屏中文界面实际只拉 2–4 片
 *   (约 150–250KB),不是一次性把整套拉下来。全量 101 片是 12.9MB ——
 *   为那 1% 的冷字付 4 倍仓库体积,不值。
 * · **一支可变字体服务所有字重**:上游对同一个(家族, 分片)的每个字重返回的是
 *   **同一个 URL**(wght 轴的可变字体),@font-face 的 font-weight 只是把它钉在
 *   某个实例上。所以磁盘上是 26 个文件、78 条规则,不是 78 个文件 ——
 *   照字重各存一份等于把同样的字节抄三遍。
 * · font-display: swap:字体没到先用回退栈画,不留空白期(FOIT)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 这份文件是**生成物**,别手改;要换字重 / 分片就改抓取脚本再跑一次。
 */
`
  const body = rules
    .map(
      (r) => `@font-face {
  font-family: '${r.family}';
  font-style: normal;
  font-weight: ${r.weight};
  font-display: swap;
  src: url('./${r.file}') format('woff2');${r.range ? `\n  unicode-range: ${r.range};` : ''}
}`,
    )
    .join('\n\n')

  await writeFile(path.join(OUT, 'fonts.css'), `${header}\n${body}\n`, 'utf-8')

  const listed = await readdir(OUT)
  let onDisk = 0
  for (const f of listed) onDisk += (await stat(path.join(OUT, f))).size
  console.log(`\nwrote ${files} woff2 (${(bytes / 1048576).toFixed(2)} MB) + fonts.css`)
  console.log(`dir total: ${(onDisk / 1048576).toFixed(2)} MB, ${listed.length} files`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
