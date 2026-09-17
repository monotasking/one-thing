import { useEffect, useRef, useState } from 'react'
import type { PetChattinessSetting } from '@shared/ipc/settings'
import { useQuery } from '../../data/kernel'
import {
  adoptPet,
  petCurrentQuery,
  petRosterQuery,
  sayPet,
  useCurrentPetId,
  type PetRosterEntryView,
} from '../../data/pet-source'
import {
  PET_CHATTINESS_LEVELS,
  petChattinessQuery,
  setPetChattinessMutation,
} from '../../data/pet-settings-source'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { findBuiltinPet } from '../../pets/builtin'
import { PetRigView } from '../../pets/rigs/PetRigView'
import { useRoving } from '../../ui/a11y/roving'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Segmented } from '../../ui/Segmented'
import { Section } from './Section'
import shared from './Settings.module.css'
import s from './PetSettings.module.css'

/** 「它正在说话。」留多久(§12.5 试听被挡那一行)。 */
export const PET_PREVIEW_BUSY_MS = 3_000

const LEVEL_LABEL: Record<PetChattinessSetting, MessageKey> = {
  quiet: 'pet.settings.quiet',
  balanced: 'pet.settings.balanced',
  chatty: 'pet.settings.chatty',
}

const LEVEL_HINT: Record<PetChattinessSetting, MessageKey> = {
  quiet: 'pet.settings.quietHint',
  balanced: 'pet.settings.balancedHint',
  chatty: 'pet.settings.chattyHint',
}

/**
 * 设置「宠物」页(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.4 / §12.5)。
 * 两节:**谁陪你**(一只一张卡,点了就领养)与**多久开口一次**(三档 + 试听)。
 *
 * 数据两条线:谁 / 长什么样 / 试听句来自 `pet:` 资源(`pet-source.ts` 的名册、`current`、
 * `adopt` / `say` 做法);开口频率是一格设置(`pet-settings-source.ts`)。这一页一只宠物的
 * 名字都不认识 —— 卡片按名册画,台词字典按 id 从 `pets/builtin` 查。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**
 *
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | 名册、`current`、开口频率各 `ensure()` 一次(栖位开过的话前两格命中缓存) |
 * | 换宠物 | `adopt` 一发;成功 → `current` 换成那一只(乐观)并后台对账;栖位按新 id 重挂 |
 * | 试听 | `say { mode: speak, text: 这只的 sample }` 一发;被挡 → 3s 计时器 |
 * | 卸载 | 清 3s 计时器;在飞的领养回来时不再改屏(序号比对 + 卸载标记) |
 *
 * ② **UI 生命状态**(§12.5「设置页」那张表逐行)
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 首载 | 名册还没回来 / 开口频率还没回来 | 卡片区与三档按钮**占位但不画内容**(不画骨架) |
 * | 读到 | 名册 + `current` 回来 | 当前宠物卡片选中;频率按设置值选中 |
 * | 换宠物进行中 | 点了一张卡、`adopt` 在飞 | 目标卡片选中,其余卡片照样可点(再点以最后一次为准) |
 * | 换宠物失败 | `adopt` 抛 | 回到原选中;目标卡片下一行错话,下一次操作清掉 |
 * | 试听被挡 | `say` 答 `said: false` | 按钮下一行「它正在说话。」,3s 后消失 |
 * | 无宠物 | 名册读失败(宿主没开 `pets`) | 整页一句「这台设备上没有宠物。」 |
 * | 超量 | 名册很长 | 卡片网格按下限宽折行,页自己滚 |
 *
 * ③ **UI 交互状态**:卡片是一组单选(`role=radio`,方向键在组里走,`ui/a11y/roving`);
 *    rest / hover(底色)/ focus(全局环)/ checked(描边 + 底色)。没有 disabled —— 在飞的
 *    时候也可以再点(§12.5)。三档随 `ui/Segmented`,试听随 `ui/Button`;试听只在「还不知道是
 *    哪一只」(首载)时禁着 —— 被挡是一句话,不是一颗灰钮。
 */
export function PetSettings() {
  const t = useT()
  const roster = useQuery(petRosterQuery)
  const currentId = useCurrentPetId()
  const chattiness = useQuery(petChattinessQuery).data

  const [picking, setPicking] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const pickSeq = useRef(0)
  const alive = useRef(true)
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tilesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    alive.current = true
    void petRosterQuery.ensure()
    void petCurrentQuery.ensure()
    void petChattinessQuery.ensure()
    return () => {
      alive.current = false
      clearTimeout(busyTimer.current)
    }
  }, [])

  useRoving(tilesRef, { axis: 'horizontal' })

  const pets = roster.data
  // 无宠物:名册读不到(`pet:` 没登记)。读到过一次之后再失败不算 —— 律②,旧值留着。
  if (pets === undefined && roster.error !== undefined) {
    return (
      <p className={s.none} data-testid="pet-settings-none">
        {t('pet.settings.none')}
      </p>
    )
  }

  const selectedId = picking ?? currentId
  const selected = pets?.find((pet) => pet.id === selectedId)

  /** 「下一次操作清掉」那一行错话。 */
  const clearNotes = () => setFailedId(null)

  const pick = (entry: PetRosterEntryView) => {
    clearNotes()
    if (picking === null && entry.id === currentId) return
    const seq = ++pickSeq.current
    setPicking(entry.id)
    adoptPet(entry.id).then(
      () => {
        if (!alive.current || seq !== pickSeq.current) return
        setPicking(null)
      },
      () => {
        if (!alive.current || seq !== pickSeq.current) return
        setPicking(null)
        setFailedId(entry.id)
      },
    )
  }

  const preview = () => {
    clearNotes()
    if (!selected) return
    sayPet(selected.sample).then(
      (receipt) => {
        if (!alive.current || receipt.said) return
        clearTimeout(busyTimer.current)
        setPreviewBusy(true)
        busyTimer.current = setTimeout(() => {
          if (alive.current) setPreviewBusy(false)
        }, PET_PREVIEW_BUSY_MS)
      },
      () => undefined,
    )
  }

  return (
    <>
      <p className={s.intro}>{t('pet.settings.intro')}</p>

      <Section titleKey="pet.settings.who">
        <div
          ref={tilesRef}
          className={s.tiles}
          role="radiogroup"
          aria-label={t('pet.settings.who')}
          aria-busy={pets === undefined || undefined}
          data-testid="pet-settings-tiles"
        >
          {pets?.map((entry) => {
            const local = findBuiltinPet(entry.id)
            const on = entry.id === selectedId
            return (
              <div key={entry.id} className={s.tileSlot}>
                <ButtonBase
                  role="radio"
                  aria-checked={on}
                  data-roving-item=""
                  className={on ? `${s.tile} ${s.tileOn}` : s.tile}
                  onClick={() => pick(entry)}
                  data-testid={`pet-tile-${entry.id}`}
                >
                  <span className={s.tileArt} aria-hidden="true">
                    <PetRigView rig={entry.rig} pose="sitting" mouth="closed" />
                  </span>
                  <span className={s.tileText}>
                    <span className={s.tileName}>{local ? t(local.name) : entry.name}</span>
                    {local ? <span className={s.tileBlurb}>{t(local.blurb)}</span> : null}
                  </span>
                </ButtonBase>
                {failedId === entry.id ? (
                  <span className={s.tileError} role="status" data-testid={`pet-tile-error-${entry.id}`}>
                    {t('pet.settings.adoptFailed')}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </Section>

      <Section titleKey="pet.settings.chattiness">
        <div className={s.levels} data-testid="pet-settings-levels">
          {chattiness === undefined ? null : (
            <>
              <Segmented
                label={t('pet.settings.chattiness')}
                options={PET_CHATTINESS_LEVELS.map((level) => ({ value: level, label: t(LEVEL_LABEL[level]) }))}
                value={chattiness}
                onChange={(level) => {
                  clearNotes()
                  void setPetChattinessMutation.run(level)
                }}
              />
              <span className={shared.settingRowHint} data-testid="pet-settings-level-hint">
                {t(LEVEL_HINT[chattiness])}
              </span>
            </>
          )}
        </div>
        <div className={s.preview}>
          <Button onClick={preview} disabled={!selected} data-testid="pet-settings-preview">
            {t('pet.settings.preview')}
          </Button>
          {previewBusy ? (
            <span className={s.previewNote} role="status" data-testid="pet-settings-preview-busy">
              {t('pet.settings.previewBusy')}
            </span>
          ) : null}
        </div>
      </Section>
    </>
  )
}
