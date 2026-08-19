#!/usr/bin/env node
// `bun run log:tail` —— 把 JSONL 诊断日志按人眼友好的格式打出来,并跟随新行。
//
// 存在的理由:拍板 A 把落盘格式换成 JSONL(文本行是 `[object Object]` 与多行栈
// 的根源),代价是文件不好直接看。这个脚本就是那个代价的补偿。
//
//   bun run log:tail                       # 跟随 <store>/log/app.jsonl
//   bun run log:tail --ns engine.*         # 只看某棵命名空间子树
//   bun run log:tail --level warn          # 只看 warn 及以上
//   bun run log:tail --session <id>        # 只看某个会话(fields.sessionId)
//   bun run log:tail --file server.jsonl   # 换一本(server / daemon)
//   bun run log:tail --lines 200 --no-follow
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
const LEVEL_VALUE = Object.fromEntries(LEVELS.map((level, index) => [level, index]))

const ESC = '\u001b'
const COLORS = {
  trace: `${ESC}[90m`,
  debug: `${ESC}[36m`,
  info: `${ESC}[32m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
  fatal: `${ESC}[35m`,
}
const DIM = `${ESC}[2m`
const RESET = `${ESC}[0m`
const useColor = process.stdout.isTTY && !process.env.NO_COLOR

function parseArgs(argv) {
  const options = { follow: true, lines: 80 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => argv[++index]
    if (arg === '--ns') options.ns = value()
    else if (arg === '--level') options.level = value()
    else if (arg === '--session') options.session = value()
    else if (arg === '--run') options.run = value()
    else if (arg === '--file') options.file = value()
    else if (arg === '--lines' || arg === '-n') options.lines = Number(value())
    else if (arg === '--no-follow') options.follow = false
    else if (arg === '--follow' || arg === '-f') options.follow = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!options.file) options.file = arg
  }
  return options
}

function storeRoot() {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function resolveLogFile(file) {
  const name = file || 'app.jsonl'
  if (path.isAbsolute(name)) return name
  if (name.includes(path.sep)) return path.resolve(name)
  return path.join(storeRoot(), 'log', name)
}

function nsMatcher(pattern) {
  if (!pattern || pattern === '*') return () => true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return ns => ns === prefix || ns.startsWith(`${prefix}.`)
  }
  if (pattern.includes('*')) {
    const source = `^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
    const re = new RegExp(source)
    return ns => re.test(ns)
  }
  return ns => ns === pattern || ns.startsWith(`${pattern}.`)
}

function pad(value, width) {
  return String(value).padEnd(width, ' ')
}

function render(record, options) {
  if (options.json) return JSON.stringify(record)
  const date = new Date(record.time)
  const clock = `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}`
  const color = useColor ? COLORS[record.level] ?? '' : ''
  const reset = useColor ? RESET : ''
  const dim = useColor ? DIM : ''
  const fields = record.fields && Object.keys(record.fields).length > 0
    ? ` ${dim}${JSON.stringify(record.fields)}${reset}`
    : ''
  let line = `${dim}${clock}${reset} ${color}${pad(String(record.level).toUpperCase(), 5)}${reset} ${pad(record.ns, 22)} ${record.msg}${fields}`
  if (record.err) {
    // 栈通常已经以 `Name: message` 开头 —— 别把同一行打两遍。
    const head = `${record.err.name}: ${record.err.message}`
    const stack = record.err.stack
    if (stack?.startsWith(head)) line += `\n${stack.split('\n').map(entry => `    ${entry}`).join('\n')}`
    else {
      line += `\n  ${color}${head}${reset}`
      if (stack) line += `\n${stack.split('\n').map(entry => `    ${entry}`).join('\n')}`
    }
  }
  return line
}

function emit(rawLine, options, matchNs) {
  const text = rawLine.trim()
  if (!text) return
  let record
  try {
    record = JSON.parse(text)
  } catch {
    // 不是我们写的行(手工塞进来的),原样打出来而不是吞掉。
    process.stdout.write(`${text}\n`)
    return
  }
  if (!record || typeof record !== 'object' || typeof record.ns !== 'string') return
  if (!matchNs(record.ns)) return
  if (options.level && LEVEL_VALUE[record.level] < LEVEL_VALUE[options.level]) return
  if (options.session && record.fields?.sessionId !== options.session) return
  if (options.run && record.fields?.runId !== options.run) return
  process.stdout.write(`${render(record, options)}\n`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write('Usage: bun run log:tail [--ns engine.*] [--level warn] [--session <id>] [--run <id>]\n'
    + '                        [--file app.jsonl] [--lines N] [--no-follow] [--json]\n')
  process.exit(0)
}
if (options.level && !(options.level in LEVEL_VALUE)) {
  process.stderr.write(`[log:tail] unknown level: ${options.level} (expected one of ${LEVELS.join('|')})\n`)
  process.exit(1)
}

const filePath = resolveLogFile(options.file)
const matchNs = nsMatcher(options.ns)

if (!fs.existsSync(filePath)) {
  process.stderr.write(`[log:tail] no such log file: ${filePath}\n`)
  process.exit(1)
}

const initial = fs.readFileSync(filePath, 'utf8')
let position = Buffer.byteLength(initial)
const initialLines = initial.split('\n').filter(Boolean)
const tail = Number.isFinite(options.lines) && options.lines > 0
  ? initialLines.slice(-options.lines)
  : initialLines
for (const line of tail) emit(line, options, matchNs)

if (!options.follow) process.exit(0)

let pending = ''
function readNew() {
  let size
  try {
    size = fs.statSync(filePath).size
  } catch {
    return
  }
  // 轮转后文件变小 —— 从头开始读新文件,而不是坐等一个永远不会到的偏移。
  if (size < position) position = 0
  if (size === position) return
  const stream = fs.createReadStream(filePath, { start: position, end: size - 1, encoding: 'utf8' })
  position = size
  stream.on('data', chunk => {
    pending += chunk
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) emit(line, options, matchNs)
  })
}

fs.watchFile(filePath, { interval: 250 }, readNew)
process.on('SIGINT', () => process.exit(0))
