// 把画布 HTML 渲染成 PNG。用仓里现成的 playwright。
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1720, height: 1200 }, deviceScaleFactor: 2 })
await page.goto('file://' + path.join(dir, 'system-architecture.html'))
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(dir, 'system-architecture.png'), fullPage: false })
await browser.close()
console.log('rendered')
