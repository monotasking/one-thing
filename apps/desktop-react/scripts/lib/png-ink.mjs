/**
 * **像素层取样口的两件家伙**:一只零依赖的 PNG 解码器,与一只墨迹加权质心。
 *
 * 为什么要它们(G 线 P1g,2026-09-21):用户给的真机录屏逐帧量出来,「正在生成 ·
 * 16.9s  停止」那一行**画出来的字**在两个取值之间翻,差恰好 **1 个设备像素**,
 * 25 秒里跳 16 次。而 `gate:tail-jitter` 读的是 `getBoundingClientRect()` ——
 * **盒的几何**,它恒为一个取值。盒不动而字在动,就只能去量**真的画出去的像素**。
 *
 * ── 为什么自己写解码器 ────────────────────────────────────────────────────
 * 仓里能解 PNG 的只有 `sharp`(原生、而且 `electron-builder.yml` 里是被排除的那一族)。
 * 一道门不该为了读几百个小图就把一个原生依赖拽进来,而 PNG 的 8 位真彩那一档
 * 解起来只有「zlib 解压 + 五种行过滤器」两件事,`node:zlib` 自带。所以这里自己写,
 * **只支持这道门真的会拿到的那一档**(CDP `Page.captureScreenshot` 吐的是
 * 8 位、非隔行、colorType 2(RGB)或 6(RGBA)),其余一律当场抛错,不做静默降级 ——
 * 一只解错了还不吭声的解码器,比没有更糟。
 *
 * ── 墨迹质心的量法 ────────────────────────────────────────────────────────
 * 与 Fable 逐帧量那段录屏用的是同一条式子:灰度 → 减去底色 → 小于阈值当没有 →
 * 行加权质心。三处与录屏不同的收窄,都写在 `inkCentroid` 上。
 */
import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 解一张 PNG,吐 `{ width, height, channels, data }`(逐像素 8 位,行优先)。
 *
 * 支持的档:位深 8、非隔行、colorType 2(RGB)/ 6(RGBA)/ 0(灰度)/ 4(灰度+A)。
 * 其余抛错 —— 见文件头那句「不做静默降级」。
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('png: 签名不对')
  let at = 8
  let header
  const idat = []
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    at += 12 + length
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('png: 没有 IHDR')
  if (header.depth !== 8) throw new Error(`png: 只解 8 位,拿到 ${header.depth}`)
  if (header.interlace !== 0) throw new Error('png: 只解非隔行')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  if (!channels) throw new Error(`png: 不认的 colorType ${header.colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const { width, height } = header
  const stride = width * channels
  const out = Buffer.allocUnsafe(stride * height)
  let src = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i]
      const a = i >= channels ? row[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          // Paeth
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`png: 不认的行过滤器 ${filter}`)
      }
      row[i] = value & 0xff
    }
    src += stride
  }
  return { width, height, channels, data: out }
}

/** 一个像素的灰度(整数 0–255)。 */
function grayAt(img, x, y) {
  const i = (y * img.width + x) * img.channels
  const d = img.data
  if (img.channels <= 2) return d[i]
  // Rec.601,与录屏那一趟同一条式子(整数够用,这里只比相对量)。
  return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
}

/**
 * **一片区域里「墨」的加权质心**,单位是**这张图自己的像素**(= 设备像素)。
 *
 * 量法与 Fable 逐帧量那段真机录屏的脚本同源,三处收窄写在这儿:
 *  ① **底色现算,不写死 247**。录屏那一趟的底是浅色纸,这道门要在任何主题下都
 *     成立,所以底色取这片区域里**出现得最多的那个灰度**(众数)——「一片字」里
 *     绝大多数像素是底,这是稳的;写死一个数换个主题就全是噪声。
 *  ② **墨 = |灰度 − 底色|**,深字浅底与浅字深底同一条式子。
 *  ③ **小于 `threshold` 当没有**(缺省 12,与录屏那一趟同值):抗 JPEG/缩放噪声与
 *     抗锯齿的长尾,不然质心会被整片底的微小起伏拖着走。
 *
 * 回 `null` = 这片区域里**没有墨**(权重和为 0)。调用方要把这一帧当「没采到」,
 * 不要当 0 —— 那是两件事。
 */
export function inkCentroid(img, box = {}, threshold = 12) {
  const x0 = Math.max(0, Math.floor(box.x0 ?? 0))
  const y0 = Math.max(0, Math.floor(box.y0 ?? 0))
  const x1 = Math.min(img.width, Math.ceil(box.x1 ?? img.width))
  const y1 = Math.min(img.height, Math.ceil(box.y1 ?? img.height))
  if (x1 <= x0 || y1 <= y0) return null

  // ① 底色 = 这片区域里出现最多的那个灰度(直方图众数)。
  const histogram = new Uint32Array(256)
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) histogram[Math.round(grayAt(img, x, y))] += 1
  }
  let background = 0
  for (let v = 1; v < 256; v += 1) if (histogram[v] > histogram[background]) background = v

  let weight = 0
  let sumY = 0
  let sumX = 0
  let minInkX = Infinity
  let maxInkX = -Infinity
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const w = Math.abs(grayAt(img, x, y) - background)
      if (w < threshold) continue
      weight += w
      sumY += w * (y + 0.5)
      sumX += w * (x + 0.5)
      if (x < minInkX) minInkX = x
      if (x > maxInkX) maxInkX = x
    }
  }
  if (weight <= 0) return null
  return {
    x: sumX / weight,
    y: sumY / weight,
    weight,
    background,
    /** 墨的最左 / 最右列(左缘那一条判据要的是它,不是质心)。 */
    inkLeft: minInkX,
    inkRight: maxInkX,
  }
}
