import s from './Divider.module.css'

/**
 * `---` 分隔线(mdast `thematicBreak`)。零参数:没有内容,只有存在。
 *
 * `data-prose="hr"` 是节奏表的钩子(表在 content/ChatStream.module.css):
 * 分隔线两侧各留 `--pr-hr` —— 比段距多一档,和物件同一个道理:它标记的是
 * 「一段话说完了」,不是句与句之间的一次呼吸。`<hr>` 自带 separator 语义,
 * 读屏会如实念「分隔线」,不用再报角色。
 */
export function Divider() {
  return <hr className={s.divider} data-prose="hr" />
}
