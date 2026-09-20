/**
 * 内置引用类型的登记处 —— **一种一行**。
 *
 * 顺序即提示词里的出场顺序。加一种引用就是在这里加一行 import 和一行 register,
 * 提示词、纯文本投影两处自动跟上;不改编解码器,不改 builder,不改 composer。
 */

import { refTypes } from '../registry.js'
import { commandRefType } from './command.js'
import { dirRefType } from './dir.js'
import { fileRefType } from './file.js'
import { linkRefType } from './reference.js'
import { skillRefType } from './skill.js'

refTypes.register(fileRefType)
refTypes.register(dirRefType)
refTypes.register(skillRefType)
refTypes.register(commandRefType)
refTypes.register(linkRefType)

export { commandRefType, dirRefType, fileRefType, linkRefType, skillRefType }
