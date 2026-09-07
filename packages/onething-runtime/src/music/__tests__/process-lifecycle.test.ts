import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createElectronMusicProcessRunner } from '../process-runner.js'

it.skipIf(process.platform === 'win32')('quiesces an owned child and grandchild and drains their actual stdio closure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'music-process-group-'))
  const runner = createElectronMusicProcessRunner()
  let output = ''
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const childFile = path.join(directory, 'child.cjs')
  const grandchildFile = path.join(directory, 'grandchild.cjs')
  await fs.writeFile(grandchildFile, `
    process.on('SIGTERM', () => { process.stdout.write('grandchild-terminated\\n'); process.exit(0) });
    process.stdout.write('grandchild-ready:' + process.pid + '\\n');
    setInterval(() => {}, 1000);
  `)
  await fs.writeFile(childFile, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });
    process.on('SIGTERM', () => { process.stdout.write('child-terminated\\n'); child.on('close', () => process.exit(0)) });
    process.stdout.write('child-ready:' + process.pid + '\\n');
    setInterval(() => {}, 1000);
  `)
  try {
    const child = runner.spawn({ command: process.execPath, args: [childFile, grandchildFile], onStdout: chunk => {
      output += chunk
      if (output.includes('grandchild-ready:')) ready()
    } })
    await started
    const childPid = Number(/(?:^|\n)child-ready:(\d+)/.exec(output)?.[1])
    const grandchildPid = Number(/grandchild-ready:(\d+)/.exec(output)?.[1])
    expect(childPid).toBeGreaterThan(0)
    expect(grandchildPid).toBeGreaterThan(0)
    runner.quiesce()
    await runner.drain()
    await child.done
    expect(output).toContain('child-terminated')
    expect(output).toContain('grandchild-terminated')
    expect(() => process.kill(childPid, 0)).toThrow()
    expect(() => process.kill(grandchildPid, 0)).toThrow()
    expect(() => runner.run({ command: process.execPath, args: [] })).toThrow('shutting down')
  } finally {
    await runner.drain()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
