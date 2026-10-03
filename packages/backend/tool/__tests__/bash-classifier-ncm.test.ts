import { describe, expect, it } from 'vitest'
import { classifyBashCommand } from '../bash-classifier.js'

/**
 * The model plays music by driving ncm-cli through bash, so these commands run
 * dozens of times a session. Prompting for each would make music unusable —
 * but the same binary can post public comments and rewrite playlists, so the
 * line has to sit at consequence, not convenience.
 */
describe('classifyBashCommand: ncm-cli', () => {
  const decisionOf = (command: string) => classifyBashCommand(command).decision

  it('runs transport control without asking', () => {
    // "下一首" must not open a permission dialog.
    for (const command of [
      'ncm-cli next',
      'ncm-cli pause',
      'ncm-cli resume',
      'ncm-cli stop',
      'ncm-cli volume 40',
      'ncm-cli seek 30',
      'ncm-cli state',
      'ncm-cli queue',
      'ncm-cli queue add --encrypted-id ABC --original-id 1 --next',
      'ncm-cli queue clear',
    ]) {
      expect(decisionOf(command), command).toBe('allow')
    }
  })

  it('runs reads without asking', () => {
    for (const command of [
      'ncm-cli search song --keyword 晴天',
      'ncm-cli recommend daily --limit 10',
      'ncm-cli song lyric --songId ABC',
      'ncm-cli comment list-hot --type 0 --resourceId ABC --limit 5 --offset 0',
      'ncm-cli user history',
      'ncm-cli user favorite',
      'ncm-cli playlist tracks --playlistId 1',
      'ncm-cli config get player',
      'ncm-cli login --check',
      'ncm-cli commands',
    ]) {
      expect(decisionOf(command), command).toBe('allow')
    }
  })

  it('runs the skill setup probes without asking', () => {
    // The skill's step 1-3 environment checks. `ncm-cli --version` prompting
    // means every music request starts with a permission dialog.
    for (const command of [
      'ncm-cli --version',
      'ncm-cli --version 2>&1',
      'ncm-cli -V',
      'ncm-cli play --help',
      'ncm-cli help queue',
      'mpv --version',
      'mpv --version 2>&1',
    ]) {
      expect(decisionOf(command), command).toBe('allow')
    }
    // `--help` neutralizes execution (commander prints usage and exits), so
    // even a scary-looking pair is safe with it; without it, it still asks.
    expect(decisionOf('ncm-cli config set --help')).toBe('allow')
    expect(decisionOf('ncm-cli config set privateKey xxx')).toBe('ask')
    // mpv with an actual file plays sound at the user — still asks.
    expect(decisionOf('mpv song.mp3')).toBe('ask')
  })

  it('runs settle-then-check composites without asking', () => {
    // `sleep N && ncm-cli state` is a model habit; every distinct duration
    // used to raise its own permission dialog.
    expect(decisionOf('sleep 2 && ncm-cli state')).toBe('allow')
    expect(decisionOf('sleep 1 && ncm-cli state 2>&1')).toBe('allow')
  })

  it('runs the legacy playback prefix without asking', () => {
    // The skill's one reliable starter: env prefixes are stripped before
    // classification, so this is just `ncm-cli play` underneath.
    expect(
      decisionOf('NCM_LEGACY_PLAY=1 ncm-cli play --song --encrypted-id ABC --original-id 1'),
    ).toBe('allow')
  })

  it('asks before anything that writes to the user account', () => {
    // `song like` edits 红心歌单 — indistinguishable from `song lyric` by
    // prefix, and pressing it by accident is exactly how a real 红心 got
    // removed from this user's account during development.
    for (const command of [
      'ncm-cli song like --songId ABC',
      'ncm-cli song dislike --songId ABC',
      'ncm-cli playlist create --playlistName 跑步',
      'ncm-cli playlist add --playlistId 1 --songIdList ABC',
      'ncm-cli playlist remove --playlistId 1 --songIdList ABC',
    ]) {
      expect(decisionOf(command), command).toBe('ask')
    }
  })

  it('asks before publishing anything public', () => {
    for (const command of [
      'ncm-cli comment post --resourceType 0 --resourceId ABC --content hi',
      'ncm-cli comment reply --commentId 1 --resourceType 0 --resourceId ABC --content hi',
      'ncm-cli note publish --title x --msg y',
      'ncm-cli note delete --eventId 1',
    ]) {
      expect(decisionOf(command), command).toBe('ask')
    }
  })

  it('asks before uploads, credit spending, and credentials', () => {
    for (const command of [
      'ncm-cli cloudupload uploadFile --file /tmp/x.mp3',
      'ncm-cli podcast voiceUpload --audio /tmp/x.mp3 --name x --voiceListId 1 --description y',
      'ncm-cli aisong generate --inspiration 秋天',
      'ncm-cli config set privateKey /tmp/key',
      'ncm-cli config set player mpv',
      'ncm-cli logout',
      // Uploads local logs to NetEase.
      'ncm-cli diag report',
    ]) {
      expect(decisionOf(command), command).toBe('ask')
    }
  })

  it('asks before starting a TUI, which the app owns', () => {
    // The offscreen keepalive is the app's; a second TUI would fight it.
    expect(decisionOf('ncm-cli tui')).toBe('ask')
  })

  it('asks before an unrecognised subcommand rather than assuming it is safe', () => {
    // The command tree is server-driven: NetEase ships new commands without us.
    // An unknown one must not inherit the allowance of its group.
    expect(decisionOf('ncm-cli song someNewWriteCommand --songId ABC')).toBe('ask')
    expect(decisionOf('ncm-cli brandNewGroup doSomething')).toBe('ask')
  })
})
