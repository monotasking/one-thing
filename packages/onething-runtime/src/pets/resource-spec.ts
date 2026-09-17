/**
 * `pet:` 的自述(宠物 P2,正本 `docs/design/pet-system-2026-09.md` §3 / §9.3)。纯数据。
 *
 * 实现在装配层(`@onething/backend/wiring/resource/pet-provider.ts`),读 / 做都转给
 * `PetsSubsystem`。只有装配了宠物子系统的宿主才登记这份自述(`OnethingBackendOptions.pets`),
 * 没登记的宿主上 `pet:` 就是「没有这种资源」—— 壳读 `current` 失败,栖位照 P1 行为跑。
 *
 * ── 地址:一个单例 ─────────────────────────────────────────────────────────
 * `pet:current`。这台机器上同一时刻只有一只宠物(§2.5「宠物同一时刻只在一个地方」),
 * 与 `music:radio` 同理 —— 路径是字面量,`ref` 可省;给了别的路径当场说不。
 *
 * ── 效果 ──────────────────────────────────────────────────────────────────
 *   · `adopt` / `say` 是 `ui_change`:它们只改变屏幕上那只宠物是谁、说了什么,不碰任何
 *     应用的数据;
 *   · `poke` / `stroke` 是空数组:壳的手势,只发事件、记账,**不产生话语**(嘀咕在壳本地)。
 *
 * ── 事件与时刻 ────────────────────────────────────────────────────────────
 * `poked` / `stroked` 带 `moment: { weight: 'low' }`,所以它们本身也是时刻 —— 走与别的
 * 应用的事实完全相同的那条路进宿主(§9.4),落进账本,不开口。`utterance` 与 `hushed`(P3,§10.4:
 * 一句开口真的说完了)**不带** `moment`:宠物不对自己说的话起反应。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const PET_RESOURCE_SCHEME = 'pet'
/** 唯一的地址路径。 */
export const PET_CURRENT_PATH = 'current'
export const PET_CURRENT_REF = `${PET_RESOURCE_SCHEME}:${PET_CURRENT_PATH}`

const EMPTY: JsonSchema = { type: 'object', properties: {}, required: [] }

const SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    rig: { type: 'string', description: 'Which drawing the shell uses for this pet.' },
  },
  required: ['id', 'name', 'rig'],
}

const UTTERANCE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    petId: { type: 'string' },
    mode: { type: 'string', enum: ['speak', 'mutter'], description: 'speak = out loud and takes the attention budget; mutter = text only.' },
    text: { type: 'string' },
    about: {
      type: 'object',
      properties: { scheme: { type: 'string' }, event: { type: 'string' } },
      required: ['scheme', 'event'],
      description: 'The fact this line reacts to. Absent for lines asked for with say.',
    },
    at: { type: 'number', description: 'Epoch milliseconds.' },
    duck: { type: 'boolean', description: 'Whether apps making sound should lower their volume.' },
  },
  required: ['id', 'petId', 'mode', 'text', 'at', 'duck'],
}

const GESTURE_PAYLOAD: JsonSchema = {
  type: 'object',
  properties: { at: { type: 'number', description: 'Epoch milliseconds.' } },
  required: ['at'],
}

export const petResourceSpec: ResourceSpec = {
  scheme: PET_RESOURCE_SCHEME,
  title: 'The pet living in the app (address: pet:current)',
  reads: {
    roster: {
      title: 'List the pets that can be adopted',
      query: EMPTY,
      result: {
        type: 'object',
        properties: { pets: { type: 'array', items: SUMMARY_SCHEMA } },
        required: ['pets'],
      },
    },
    current: {
      title: 'The current pet, whether it is speaking, and its last 20 lines (newest last)',
      query: EMPTY,
      result: {
        type: 'object',
        properties: {
          pet: SUMMARY_SCHEMA,
          speaking: { type: 'boolean', description: 'A spoken line is still sounding: from when it was claimed until its hushed event (text-only lines: their estimated length).' },
          speakingUntil: { type: 'number', description: 'Present only while speaking. Epoch milliseconds.' },
          utterances: { type: 'array', items: UTTERANCE_SCHEMA },
        },
        required: ['pet', 'speaking', 'utterances'],
      },
    },
  },
  ops: {
    adopt: {
      title: 'Switch to another pet',
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'A pet id from the roster read.' } },
        required: ['id'],
      },
      effects: ['ui_change'],
      home: 'core',
      describe: params => `Adopt the pet ${String((params as { id?: unknown } | null)?.id ?? '')}`,
    },
    say: {
      title: 'Make the pet say one line',
      params: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['speak', 'mutter'], description: 'speak follows the attention budget (one line at a time); mutter never does.' },
          text: { type: 'string', description: 'What to say. At most two short sentences.' },
        },
        required: ['mode', 'text'],
      },
      effects: ['ui_change'],
      home: 'core',
    },
    poke: {
      title: 'The user poked the pet',
      params: EMPTY,
      effects: [],
      home: 'core',
    },
    stroke: {
      title: 'The user stroked the pet',
      params: EMPTY,
      effects: [],
      home: 'core',
    },
  },
  events: {
    utterance: {
      title: 'The pet said a line',
      payload: UTTERANCE_SCHEMA,
    },
    hushed: {
      title: 'A spoken line has really ended (played out, failed or was stopped)',
      payload: {
        type: 'object',
        properties: {
          utteranceId: { type: 'string', description: 'The id of the utterance that ended.' },
          at: { type: 'number', description: 'Epoch milliseconds.' },
        },
        required: ['utteranceId', 'at'],
      },
    },
    poked: {
      title: 'The user poked the pet',
      payload: GESTURE_PAYLOAD,
      moment: { weight: 'low', gist: '用户戳了宠物' },
    },
    stroked: {
      title: 'The user stroked the pet',
      payload: GESTURE_PAYLOAD,
      moment: { weight: 'low', gist: '用户撸了宠物' },
    },
  },
}
