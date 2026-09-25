/**
 * 图片 alt 的**显示口径**(G 线 P5-a,正本 `docs/stream-geometry-2026-09.md` §23.3)。
 *
 * 引擎写生成图时把媒体 id 塞进了 alt:`![Generated Image|mediaId:<id>](media://<id>.png)`
 * (`buildOnethingGeneratedImageMarkdown`)。那一截 `|mediaId:<id>` 是**给机器读的标记**
 * —— Gemini 多轮改图靠它找回字节 —— 不是给人读的字,原样显出来屏幕上就是一串 id。
 *
 * 所以显示时剥掉,只剥这一种标记,别的字一个不动:`<img alt>`、诚实行、gated 占位卡、
 * 行内芯片都经这里。**源码视图不经这里**(`view-source` 看到的仍是作者/引擎写的原行,
 * `blockSourceText` 不改)—— 看源码的人要看的正是那一行本来的样子。
 */
const MEDIA_ID_MARK = /\s*\|\s*mediaId:[^|\s]*/g

export function displayAlt(alt: string): string {
  // 快路:绝大多数 alt 没有这个标记,不必跑一次正则替换。
  if (!alt.includes('mediaId:')) return alt
  return alt.replace(MEDIA_ID_MARK, '').trim()
}
