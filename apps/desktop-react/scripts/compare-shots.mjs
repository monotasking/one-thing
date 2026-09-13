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
 * 解码那一段住在 `scripts/lib/png.mjs`(2026-09-13 抽出去的):`gate-changes` 的
 * ⑧ / ⑨ 两条也要按设备像素看画面,而两份拷贝迟早只修好其中一份。判词随它一起搬。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { decodePng } from './lib/png.mjs'

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
