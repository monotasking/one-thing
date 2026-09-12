#!/usr/bin/env node
/**
 * **两个目录里的同名 PNG 逐像素比**。
 *
 * 它服务的是壳 CLAUDE.md 那条「组件收敛战役纪律」:**迁移 = 等价替换** ——
 * 每面迁移前后真机逐态截图对照,像素差必须为零或是**列明的规范修正**。
 * 所以这只脚本只回答一件事:差了几个像素、差在哪一张。
 *
 *   node scripts/compare-shots.mjs <改前目录> <改后目录>
 *
 * ── 为什么自己解 PNG ──────────────────────────────────────────────────────
 * 仓里没有 pixelmatch / pngjs;`sharp` 倒是在(`@huggingface/transformers` 拖进来的),
 * 但拿一个**产品明知不加载、打包时还被排除**的原生模块给门当依赖是把它扶正 ——
 * 原生模块只许 N-API 那条法管的是「装了什么就要判什么」,而这里根本不必装。
 * PNG 的解码只要 zlib 加一段反滤波,五十行的事,而且**零依赖 = 这只脚本在任何一台
 * 跑得起 node 的机器上都跑得动**。
 *
 * 只认 Chromium `Page.captureScreenshot` 出的那两种:8bit 真彩、带不带 alpha 都收
 * (它按图里有没有透明像素自己挑 color 2 / 6),非隔行。遇到别的形直接说不认得,不猜
 * —— 反滤波按**每像素字节数**走,所以两种形共用同一段代码,不是两份。
 */
import { inflateSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 一张解出来的图:宽高 + RGBA 字节。 */
function decodePng(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} 不是 PNG`)
  let at = 8
  let header
  const idat = []
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const body = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += len + 12
  }
  if (!header) throw new Error(`${file} 没有 IHDR`)
  if (header.depth !== 8 || (header.color !== 6 && header.color !== 2) || header.interlace !== 0) {
    throw new Error(`${file} 不是 8bit 真彩非隔行(depth=${header.depth} color=${header.color})`)
  }
  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = header
  /** 每像素几个字节:color 2 = RGB,color 6 = RGBA。反滤波的 `a` 就往前退这么多。 */
  const bpp = header.color === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let src = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    const line = raw.subarray(src, src + stride)
    src += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        // Paeth
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`${file} 第 ${y} 行的过滤器 ${filter} 不认得`)
      }
      cur[x] = value & 0xff
    }
  }
  return { width, height, bpp, data: out }
}

function main() {
  const [before, after] = process.argv.slice(2)
  if (!before || !after) {
    console.error('用法:node scripts/compare-shots.mjs <改前目录> <改后目录>')
    process.exit(2)
  }
  const names = readdirSync(after).filter((n) => n.endsWith('.png')).sort()
  let total = 0
  let missing = 0
  for (const name of names) {
    const a = path.join(before, name)
    const b = path.join(after, name)
    let one
    let two
    try {
      one = decodePng(a)
      two = decodePng(b)
    } catch (error) {
      console.log(`  ${name.padEnd(20)} —— 比不了:${error.message}`)
      missing += 1
      continue
    }
    if (one.width !== two.width || one.height !== two.height) {
      console.log(
        `  ${name.padEnd(20)} 尺寸不同 ${one.width}×${one.height} → ${two.width}×${two.height}`,
      )
      total += Math.max(one.width * one.height, two.width * two.height)
      continue
    }
    if (one.bpp !== two.bpp) {
      // 有没有 alpha 通道由「图里有没有透明像素」决定 —— 两边不同本身就是一处差异。
      console.log(`  ${name.padEnd(20)} 通道数不同(${one.bpp} → ${two.bpp})`)
      total += one.width * one.height
      continue
    }
    let diff = 0
    for (let i = 0; i < one.data.length; i += one.bpp) {
      for (let k = 0; k < one.bpp; k += 1) {
        if (one.data[i + k] !== two.data[i + k]) {
          diff += 1
          break
        }
      }
    }
    total += diff
    const pixels = one.width * one.height
    console.log(
      `  ${name.padEnd(20)} ${one.width}×${one.height} —— 差 ${diff} 像素`
        + ` (${((diff / pixels) * 100).toFixed(3)}%)`,
    )
  }
  console.log(
    `\n[compare-shots] ${names.length} 张,合计差 ${total} 像素`
      + (missing ? `;${missing} 张比不了` : ''),
  )
}

main()
