/**
 * 音乐面分区的 id(音乐面 v9)。**只是几个字符串**,分区表(`sections.tsx`)用它们给自己那几行起名,
 * 状态表(`status.ts`)的「去哪一格」、账号那一格的「去听歌」引用它们 —— 抽成一只叶子文件,是为了
 * 让这三处互相 import 时不绕成圈(分区表 import 各分区组件,分区组件又要一个 id)。
 */
export const MUSIC_DEFAULT_SECTION_ID = 'now'
export const MUSIC_RADIO_SECTION = 'radio'
export const MUSIC_SEARCH_SECTION = 'search'
export const MUSIC_ACCOUNT_SECTION = 'account'
