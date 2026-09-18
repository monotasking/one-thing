import { useState } from 'react'
import type { FormEvent, FocusEvent } from 'react'
import { ArrowUp } from '../../components/icons'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useCurrentPetId, usePetLive } from '../../data/pet-source'
import { findBuiltinPet } from '../../pets/builtin'
import { useT } from '../../i18n'
import type { HostTalk } from './useHostTalk'
import s from '../MusicPanel.module.css'

/**
 * **跟主持人说话**(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.2)。
 *
 * 音乐面最底下一行。用户最早那句要求是「真的是电台主持人」——能跟他说话、他会回、
 * 会照你说的改节目单。今天壳上唯一能对电台说的话是抽屉里的「点歌」,那是一条结构化
 * 命令,不是一句话。
 *
 * ── 它发的 `tell` 只是把话递进去 ────────────────────────────────────────
 * 不出声、不改播放、不碰节目单。真正的改动由主持人自己的工具做,各自过各自的权限闸。
 * **他回的话不在这条输入框上** —— 那句话走宠物那条路,气泡出在唱机那边的黑豆头上
 * (§7.2);这里只画**你自己**说过的那一枚回执气泡。
 *
 * ── 建议词只填不发 ─────────────────────────────────────────────────────
 * 与电台条那几颗「预设心情」同一条判据(它们也只填进意图框):按下去就发等于替人
 * 做了决定,而这三句话本来就是给人改的模板。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(施工纪律第一条;§7.3 那张表的落地)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ─────────────────────────────────────────────────────────
 *  · 挂载    —— 不拉任何读数:要的两样(草稿、等不等他)都在 `useHostTalk` 里,
 *               名字来自宠物那条已经开着的线(`usePetLive` 是引用计数的,
 *               唱机那边也开着一份,这里再开一份只是加一减一);
 *  · 发出去  —— 框当场清空、气泡冒出来、黑豆转 `busy`;**框仍可再打字**
 *               (可以连着说两句),所以它一刻都没有禁用过;
 *  · 他回了  —— 由 `music-talk` 那格时刻收走 `busy`;这块面自己一格都不动;
 *  · 60s 没回 —— 同上,无提示;
 *  · 换宿主  —— 拖成浮窗 / 抬上舞台不重挂(拼贴树结构共享),草稿与等待都留着;
 *  · 卸载    —— 状态跟着这块面走,**不落盘**:一句没发出去的话不该跨进程活着。
 *
 * ── ② UI 生命状态 ──────────────────────────────────────────────────────
 *  · 电台关着 / 后端没配好 —— **整条不画**(父级判,§7.2 最后一行:没有主持人可说话);
 *  · 空闲    —— 一格输入 + 一颗发送键(没字时停用);
 *  · 有回执  —— 上方右对齐一枚你自己的气泡,6s 自己散;
 *  · 发送失败 —— 框下一行后端原话,气泡撤掉,字还回来;
 *  · 超量    —— 人打了一大段:输入框单行滚动(它本来就是 `<input>`),
 *               气泡最多三行然后截断 —— 它是回执不是记录,长到要滚就说明它走错了位置。
 *
 * ── ③ UI 交互状态 ──────────────────────────────────────────────────────
 *  · rest / hover / focus 全随库件(Input / Button / IconButton),这块面零手写;
 *  · 聚焦    —— 上方浮一排三颗建议词;焦点**离开整条**才收起(点建议词的那一下
 *               焦点先落在那颗钮上,按 `relatedTarget` 还在条内 → 不收,
 *               否则这一下点不着);
 *  · pending —— 发送键转圈那一格由 `sending` 说;
 *  · disabled —— 只有「框里没字」这一种(发送键);输入框自己永不停用。
 */
export function TalkBar({ talk }: { talk: HostTalk }) {
  const t = useT()
  usePetLive()
  const petId = useCurrentPetId()
  const pet = petId !== undefined ? findBuiltinPet(petId) : undefined
  const name = pet ? t(pet.name) : t('music.talk.host')
  const [focused, setFocused] = useState(false)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    talk.send()
  }

  /* 焦点还在这条里(输入框 ↔ 建议词 ↔ 发送键)就不算离开 —— 见 ③。 */
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setFocused(false)
  }

  return (
    <section
      className={s.talkbar}
      data-testid="music-talk"
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {talk.echo && (
        <p className={s.youSaid} data-testid="music-talk-echo">
          <span>{talk.echo}</span>
        </p>
      )}
      {focused && (
        <div className={s.presets}>
          {TALK_SUGGESTIONS.map((key) => (
            <Button
              key={key}
              size="sm"
              variant="ghost"
              pill
              type="button"
              data-testid="music-talk-suggestion"
              onClick={() => talk.pick(t(key))}
            >
              {t(key)}
            </Button>
          ))}
        </div>
      )}
      <form className={s.talkForm} onSubmit={onSubmit}>
        <Input
          value={talk.text}
          onValueChange={talk.setText}
          placeholder={t('music.talk.placeholder', { name })}
          aria-label={t('music.talk.placeholder', { name })}
          data-testid="music-talk-input"
        />
        <IconButton
          icon={ArrowUp}
          label={t('music.talk.send', { name })}
          type="submit"
          disabled={talk.text.trim() === ''}
          data-testid="music-talk-send"
        />
      </form>
      {talk.error && (
        <p className={s.bad} data-testid="music-talk-error">
          {talk.error}
        </p>
      )}
    </section>
  )
}

/**
 * 聚焦时浮上来的三句话。**内容样本的反面**:它们是给人改的模板,所以进字典
 * (与电台条那四颗「预设心情」同一条判据)。
 */
const TALK_SUGGESTIONS = ['music.talk.mood', 'music.talk.request', 'music.talk.what'] as const
