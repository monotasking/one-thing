/**
 * **一条线上的换序算术**(09-18 从 `ui/tab-reorder` 抽出来,给 `ui/list-reorder` 用)。
 *
 * ── 为什么它值得单独一个文件 ────────────────────────────────────────────
 * 标签条的换序与列表的换序是**两种形**(一横一竖、一个有空位与撕下、一个只有
 * 一列行),但它们中间那句话逐字相同:「被拖的那一格走到这儿,它排第几、
 * 谁该让开多少」。那句话从前只住在 `tab-reorder.track()` 里,而它是**真机
 * 量出来三版才对**的一句话(三条前科抄在下面 `reorderFrame` 上)。
 * 第二个消费者出现的那一刻,它要么抽出来,要么被抄一份 —— 抄一份的代价不是
 * 几十行字节,是两份会各自漂:标签条上「拖到最后一位」到得了、列表上到不了,
 * 而这种差别只有真机拖一次才看得见。
 *
 * ── 它**不**认识什么 ──────────────────────────────────────────────────
 * 不认识 DOM、不认识轴的名字、不认识 React。进来的是一串「起点 + 身量」,
 * 出去的是三个数。横着用就把 `start` 喂 `left`、竖着用就喂 `top` ——
 * 这是它能同时服务两种形的全部理由,所以这里一个 `x` / `y` / `left` / `top`
 * 都不许出现。
 *
 * ── 坐标系:两个下标,别弄混 ────────────────────────────────────────────
 *   `settleIndex`   **最终排第几位** —— 对着「已经把自己摘出去」的那张表说的。
 *                   让位量算它;`ui/list-reorder` 交给消费方的也是它
 *                   (「把这一行挪到第 n 位」是人话里的那个数)。
 *   `insertIndex`   **插到第几格之前** —— 对着**没摘掉任何东西**的原表说的。
 *                   `workbench` 那一族(`reorderTab` / `moveRefIntoLeaf`)收的是它,
 *                   因为同叶换序与跨条落进来最终走同一只函数。
 * 往左 / 往上挪时两者相同,往右 / 往下挪时差一格 —— 差的那一格只出现在
 * 「往后挪」那一半里,而它正是 W6-b 真机门当场量到的那条:两格里把第一格拖到
 * 末尾,答 1 恰好命中「原地不动」那道闸,序一格不变。
 */

/** 一格在这条线上的位置。横着是 `{left, width}`,竖着是 `{top, height}`。 */
export interface ReorderBox {
  /** 起边(视口坐标)。 */
  start: number
  /** 身量。 */
  size: number
}

export interface ReorderFrame {
  /** 最终排第几位(0..n-1)。让位量算的就是它。 */
  settleIndex: number
  /** 插到原表第几格之前(0..n)。`workbench` 那一族收这个。 */
  insertIndex: number
  /** 每一格这一帧该让开多少;被拖那一格恒 0。长度与 `boxes` 相同。 */
  shifts: number[]
}

/**
 * **这一下是不是拖**(起拖阈值的判定)。
 *
 * 单独一只而不是让每个消费方写 `Math.abs(d) >= t`:那个 `>=` 与 `>` 的差别在
 * 触控板上是「轻轻一碰就起拖」与「起不来」的差别,而它该只有一处判词。
 * 量的是**换序那一轴上**的位移 —— 一条竖列表里横向漂多远都不是换序
 * (同一条纪律的另一半写在 `ui/drag/constants.ts` 的 `DRAG_START_X` 上:
 * 一格标签的横向阈值与竖向阈值是两个数、两件事)。
 */
export function passedReorderThreshold(delta: number, threshold: number): boolean {
  return Math.abs(delta) >= threshold
}

/**
 * 把跟手的那一格**夹在容器两端之内**,答夹紧之后的起边。
 *
 * 不夹的话把它往容器外一甩,那一格会飞出去而槽位早就到头了 —— 屏幕上是
 * 「它跑了但什么都没发生」。两端读的是**起拖那一刻量的**那一份,不是每帧问
 * DOM:后者在真机上逼出过每发 pointermove 一次强制排版(`gate:perf` ⑤c 读数
 * p95 316 → 508ms,病历全文在 `tab-reorder.follow` 上)。
 */
export function clampLead(lead: number, min: number, max: number): number {
  return Math.max(min, Math.min(lead, Math.max(min, max)))
}

/**
 * **换序的一帧**:被拖的那一格此刻起边在 `lead`,答它排第几、谁让开多少。
 *
 * ── 判据:**被拖那一格朝运动方向的那条边越过邻居中心**(Chrome 换标签的规则)──
 * 往后拖看**后缘**:后面某个邻居的中心被它越过,那个邻居就往前滑;往前拖看**前缘**。
 * 写出来是一句话:
 *
 *   前面的邻居(i < index)  被拖的**前缘**仍在它中心之后 → 它仍排在前面,计入
 *   后面的邻居(i > index)  被拖的**后缘**越过了它中心   → 它滑到前面,计入
 *   `settleIndex` = 计入的个数,**不再另外加减**
 *
 * 三条前科被这一句一起解决,它们全是真机上量出来的病(判词原样从 `tab-reorder`
 * 搬过来,因为它们是**这段算术**的病历,不是标签条的):
 *  · **不是中心对中心**。那一版比的是被拖那格的中线与邻居中线 —— 大的那一格要
 *    整个越过小邻居才换位,手感发黏;而且容器被填满时夹位让中线最多只能**等于**
 *    末格中线,「拖到最后一位」在结构上到不了。当时的补法是两句两端特例,那是
 *    **错判据的症状,不是设计的一部分** —— 现在判据自己在两端就对:
 *      顶到前端 `lead = min` < 首个邻居中心 → 一个都不计入 → 0;
 *      顶到后端 `lead + size = max` > 每个后邻居中心 → 全计入 → last。
 *  · **不是「拿走被拖那格之后」的位置**。上一版把后面的邻居整体前移一格身量再算
 *    中心 —— 那样大的那一格一抬起来,后邻居就先跳一下(手还没动,屏幕已经变了)。
 *  · **邻居中心一律读抬起那一刻的基准矩形,不读活矩形**。邻居此刻正走在让位的
 *    过渡里,读它等于让判据自己晃:让一次位 → 中心变了 → 落点变了 → 让位反向,
 *    一帧一次来回,拖快了槽位会漂。
 *
 * ── 让位与落点是**同一句话**算出来的 ───────────────────────────────────
 * 每个邻居的让位量就是「它在落点之后就挪一格,否则不挪」,挪的那一格恒等于
 * **被拖那一格自己的身量** —— 把一格从 a 抽出来插到 b,夹在中间的每一格都正好
 * 被它顶开自己那么多,与邻居各自多高多宽无关(所以这段算术在**行高不等**的
 * 列表上照样是准的,不是近似)。两处分开算 = 屏幕上的空档与松手的结果对不上。
 */
export function reorderFrame(
  boxes: readonly ReorderBox[],
  index: number,
  lead: number,
): ReorderFrame {
  const self = boxes[index]
  const size = self.size
  let settleIndex = 0
  boxes.forEach((box, i) => {
    if (i === index) return
    const center = box.start + box.size / 2
    if (i < index ? lead >= center : lead + size > center) settleIndex += 1
  })
  /*
   * 让位:把每个邻居在「摘掉被拖那格之后」的下标 `j` 算出来,`j >= settleIndex`
   * 的往被拖那格原本的方向挪一格身量。前面的往后挪、后面的往前挪 —— 两句合成
   * 一句:`i < index` 的挪 +size 当且仅当它排到了落点之后,`i > index` 的挪
   * -size 当且仅当它没排到落点之后。
   */
  const shifts = boxes.map((_, i) => {
    if (i === index) return 0
    const j = i < index ? i : i - 1
    if (i < index) return j >= settleIndex ? size : 0
    return j >= settleIndex ? 0 : -size
  })
  return {
    settleIndex,
    insertIndex: settleIndex <= index ? settleIndex : settleIndex + 1,
    shifts,
  }
}
