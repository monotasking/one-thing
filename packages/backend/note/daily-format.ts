/**
 * moment 风格的日期格式串 → 文件名。
 *
 * 这一份是 `search/capabilities/daily-notes.ts` 的 `formatDailyDate` 的**复制**
 * (P1 只立产地不动老文件;P2 把那边改成 import 这里,复制随之消失)。
 *
 * 它住在 `notes/` 而不是 `notes/obsidian/`:日记文件名是**每一种笔记系统**都要
 * 的东西(FolderVault 现在就要,Logseq 将来也要),塞进某一个驱动的目录里就等
 * 于让下一个驱动去 import 上一个驱动。
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_SHORT_NAMES = MONTH_NAMES.map(name => name.slice(0, 3))
const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]
const WEEKDAY_SHORT_NAMES = WEEKDAY_NAMES.map(name => name.slice(0, 3))

/** 长 token 排在短 token 前面:`YYYY` 必须先于 `YY` 被认出来。 */
const DATE_FORMAT_TOKENS = ['YYYY', 'MMMM', 'MMM', 'dddd', 'ddd', 'YY', 'MM', 'M', 'DD', 'D']

/** 按用户配置的格式串排出「那一天那个文件」的名字(不带扩展名)。 */
export function formatDailyDate(format: string, date: Date): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: MONTH_NAMES[date.getMonth()],
    MMM: MONTH_SHORT_NAMES[date.getMonth()],
    dddd: WEEKDAY_NAMES[date.getDay()],
    ddd: WEEKDAY_SHORT_NAMES[date.getDay()],
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    M: String(date.getMonth() + 1),
    DD: String(date.getDate()).padStart(2, '0'),
    D: String(date.getDate()),
  }
  let output = ''
  for (let i = 0; i < format.length;) {
    const token = DATE_FORMAT_TOKENS.find(t => format.startsWith(t, i))
    if (token) {
      output += values[token]
      i += token.length
    } else {
      output += format[i]
      i += 1
    }
  }
  return output
}
