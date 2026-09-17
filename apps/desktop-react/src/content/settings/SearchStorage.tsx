import { useEffect, useRef } from 'react'
import { useQuery } from '../../data/kernel'
import { searchStatusQuery } from '../../data/search-catalog-source'
import {
  searchStorageQuery,
  shouldRemeasureStorage,
  storagePhaseOf,
} from '../../data/search-settings-source'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import shared from './Settings.module.css'
import s from './SearchStorage.module.css'

/**
 * 设置 → 搜索页的第二节:**占用空间**(2026-09-18)。
 *
 * 用户 09-17 的原话就是这一节的全部需求:「我要知道搜索占得空间,不管是现在的 fts5
 * 还是向量库。」—— 所以它**只回答「占了多少」**:三行读数 + 一行合计,没有一句解释,
 * 也没有一颗钮。要不要能一键清理是下一个问题(而且后端已经在每条索引 Worker 起身时
 * 自己收拾一次了,见 `runtime/search/index/storage.ts` 的文件头)。
 *
 * ── 为什么 WAL 不单列 ────────────────────────────────────────────────────
 * `-wal` 是**同一个库**的预写日志,它随时会被折回主库并清零。单列一行「预写日志」是
 * 拿一个实现细节占用户一行注意力,而且那一行的数会自己跳。所以它并进「字面索引」那
 * 一行的数里 —— 那一行说的是「字面检索这件事在磁盘上占了多少」,WAL 正是它的一部分。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**
 *
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | `searchStorageQuery.ensure()` 一发 |
 * | 常驻 | **不轮询** —— 这个数不会自己动。只在向量那一半从「正在嵌」走到「嵌完了」的那一刻重量一次(`shouldRemeasureStorage`);模型下载 / 删除 / 翻开关由那几条写路各自的 `settle` 负责 |
 * | 离开这一页 / 卸载 | 没有计时器要清;那一格 query 留着 = 缓存 |
 *
 * ② **UI 生命状态**(三态,判据是纯函数 `storagePhaseOf`)
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | loading | 还没回来、也没出错 | 只画合计那一行、写「计算中…」。**三行读数不画** —— 三行骨架比一行字吵得多 |
 * | ready | 拿到了 | 三行 + 合计。`vectorBytes` 缺席那一行画「—」(还没有向量库,与「0 MB」是两句不同的话) |
 * | error | 那一发红了 | **上一份读数照旧留在屏上**(律②)—— 量不到一次不等于那些地方不占了;合计底下补一行「没量出来」。一份都没有过时,合计那一行就是那句话 |
 * | 超量 | 不存在:这一节是定长的三行 + 一行,不随数据长 | — |
 *
 * ③ **UI 交互状态**:**没有交互** —— 这一节里一颗钮、一个可聚焦的东西都没有,它整个
 *    是一段读数。数字右对齐 + `tabular-nums`,于是四行的个位数对得齐。
 */
export function SearchStorage() {
  const t = useT()
  const { data, error } = useQuery(searchStorageQuery)
  const vector = useQuery(searchStatusQuery).data?.vector

  useEffect(() => {
    void searchStorageQuery.ensure()
  }, [])

  /*
   * 嵌完那一刻库真的长大了(几千份文档的向量),重量一次。**判的是跃迁不是当前值**
   * —— 首载那一帧刚 `ensure()` 过,再量一遍是白量(判据是导出的纯函数,可单测)。
   */
  const previousVector = useRef(vector)
  useEffect(() => {
    if (shouldRemeasureStorage(previousVector.current, vector)) searchStorageQuery.invalidate()
    previousVector.current = vector
  }, [vector])

  const phase = storagePhaseOf(data, error)

  return (
    <>
      {data === undefined ? null : (
        <>
          {/* WAL 并进字面那一行:它是同一个库的预写日志(见文件头)。 */}
          <Row labelKey="search.storageLexical" value={formatBytes(data.lexicalBytes + data.walBytes)} />
          <Row
            labelKey="search.storageVector"
            // 缺席 = 还没有向量库。**画破折号,不画 0 MB** —— 那是两句不同的话。
            value={data.vectorBytes === undefined ? EM_DASH : formatBytes(data.vectorBytes)}
          />
          <Row labelKey="search.storageModel" value={formatBytes(data.modelBytes)} />
        </>
      )}

      <div className={`${shared.settingRow} ${s.total}`} data-testid="search-storage-total">
        <div className={shared.settingRowLabel}>{t('search.storageTotal')}</div>
        <div className={s.value}>
          {data === undefined
            ? t(phase === 'error' ? 'search.storageFailed' : 'search.storageMeasuring')
            : formatBytes(data.totalBytes)}
        </div>
      </div>

      {/*
        旧值还在、这一发却红了 —— 两件事都说出来:上面那四行是**上一次**量到的,
        底下这一行说「刚才那次没量出来」。抹掉旧值会让人以为那些地方不占了。
      */}
      {phase === 'error' && data !== undefined ? (
        <div className={shared.settingRowNote}>{t('search.storageFailed')}</div>
      ) : null}
    </>
  )
}

/** 破折号 —— 「这一格没有数可给」。**是字形不是文案**,所以它不进字典。 */
const EM_DASH = '—'

/** 一行读数。**复用这一页现成的行形**(`.settingRow` 一族),不新造行组件。 */
function Row({ labelKey, value }: { labelKey: MessageKey; value: string }) {
  const t = useT()
  return (
    <div className={shared.settingRow}>
      <div className={shared.settingRowLabel}>{t(labelKey)}</div>
      <div className={s.value}>{value}</div>
    </div>
  )
}
