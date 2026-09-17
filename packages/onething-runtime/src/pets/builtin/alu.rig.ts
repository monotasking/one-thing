import type { DeclarativeRigSpec } from '../rig-spec.js'

/**
 * **阿绿的形象** —— 第一只只用数据画出来的宠物(宠物 P5,正本 §12.3)。
 *
 * 一只坐着的绿鹦鹉:头顶三根翘毛、两颗圆眼、黄色弯喙、脸颊一点粉。坐标系与黑豆同一张
 * 纸(`0 0 120 134`,脚落在 y≈128),所以两只能蹲在同一个栖位上、一样大。
 *
 * 部件次序就是叠放次序(先画的在下面)。头挂在身体里:随拍时整只左右摇,头跟着摇。
 *
 * 九个姿势(§7.2 的名字):
 *   sitting    尾巴慢摆
 *   grooving   身体随拍左右摇、翘毛随拍点、右脚打拍子(不点头)
 *   speaking   抬头、翘毛竖起来(喙的张合归 `mouth`)
 *   busy       歪头,喙里叼着一张唱片
 *   listening  反方向歪头、翘毛一抖一抖
 *   dozing     闭眼、头微垂、呼吸、冒 z
 *   sleeping   头埋进翅膀:头歪下去,右翅膀换成盖住头的那一片,冒 z
 *   dizzy      羽毛炸开(身后一圈尖羽)、蚊香眼、头晃、翘毛乍起
 *   petted     眯眼笑、脸颊放大、呼噜线抖、尾巴快甩
 */
export const ALU_RIG: DeclarativeRigSpec = {
  viewBox: [0, 0, 120, 134],
  palette: {
    green: '#58b85c',
    greenDark: '#3d9147',
    greenLight: '#a5d97c',
    crestTip: '#c3e05a',
    blue: '#3d7fd1',
    beak: '#f4b942',
    beakDark: '#c9861f',
    beakShine: 'rgba(255, 255, 255, 0.55)',
    mouthIn: '#6b2e2a',
    eyeWhite: '#fbf6ee',
    pupil: '#1c1c1e',
    glint: '#ffffff',
    ink: '#24361f',
    cheek: 'rgba(255, 140, 122, 0.6)',
    feet: '#d99a86',
    vinyl: '#141416',
    vinylGroove: '#34343a',
    vinylLabel: '#e39a3b',
    heart: '#e8606b',
    zz: 'rgba(214, 206, 192, 0.85)',
    purr: 'rgba(214, 206, 192, 0.6)',
  },
  parts: [
    /* 尾巴:两层长羽垂在身后 */
    { id: 'tail', shape: 'group', origin: [50, 0] },
    { id: 'tailFeathers', parent: 'tail', shape: 'path', fill: 'blue', d: 'M50 110 L44 132 Q50 135 55 129 L60 134 L65 129 Q70 135 76 132 L70 110 Z' },
    { id: 'tailInner', parent: 'tail', shape: 'path', fill: 'greenDark', d: 'M55 112 L53 127 L60 132 L67 127 L65 112 Z' },

    /* 炸毛:身后一圈尖羽(只在 dizzy 出现) */
    {
      id: 'puff',
      shape: 'path',
      fill: 'greenDark',
      hidden: true,
      origin: [50, 100],
      d: 'M30 128 L21 117 L28 108 L18 98 L30 92 L26 80 L40 80 L44 68 L55 74 L60 62 L65 74 L76 68 L80 80 L94 80 L90 92 L102 98 L92 108 L99 117 L90 128 Z',
    },

    /* 身体(头也挂在这里) */
    { id: 'body', shape: 'group', origin: [50, 100] },
    { id: 'torso', parent: 'body', shape: 'path', fill: 'green', d: 'M34 128 C26 106 30 80 60 76 C90 80 94 106 86 128 Z' },
    { id: 'belly', parent: 'body', shape: 'ellipse', fill: 'greenLight', cx: 60, cy: 108, rx: 16, ry: 19 },
    { id: 'wingL', parent: 'body', shape: 'group', origin: [80, 10] },
    { id: 'wingLShape', parent: 'wingL', shape: 'path', fill: 'greenDark', d: 'M40 86 C27 95 26 116 38 127 C45 118 48 101 40 86 Z' },
    { id: 'wingLTip', parent: 'wingL', shape: 'path', fill: 'blue', d: 'M30 111 C29 118 32 124 38 127 C40 121 38 115 30 111 Z' },
    { id: 'wingR', parent: 'body', shape: 'group', origin: [20, 10] },
    { id: 'wingRShape', parent: 'wingR', shape: 'path', fill: 'greenDark', d: 'M80 86 C93 95 94 116 82 127 C75 118 72 101 80 86 Z' },
    { id: 'wingRTip', parent: 'wingR', shape: 'path', fill: 'blue', d: 'M90 111 C91 118 88 124 82 127 C80 121 82 115 90 111 Z' },
    { id: 'purrL', parent: 'body', shape: 'path', stroke: 'purr', strokeWidth: 1.4, linecap: 'round', hidden: true, d: 'M20 96 q-5 6 0 12 M13 93 q-6 9 0 18' },
    { id: 'purrR', parent: 'body', shape: 'path', stroke: 'purr', strokeWidth: 1.4, linecap: 'round', hidden: true, d: 'M100 96 q5 6 0 12 M107 93 q6 9 0 18' },

    /* 头 */
    { id: 'head', parent: 'body', shape: 'group', origin: [50, 95] },
    { id: 'crest', parent: 'head', shape: 'group', origin: [50, 100] },
    { id: 'crestLeft', parent: 'crest', shape: 'path', fill: 'green', d: 'M55 28 C47 20 45 9 51 1 C53 11 58 17 62 26 Z' },
    { id: 'crestMid', parent: 'crest', shape: 'path', fill: 'crestTip', d: 'M59 27 C57 16 61 7 70 4 C66 13 66 19 66 28 Z' },
    { id: 'crestRight', parent: 'crest', shape: 'path', fill: 'green', d: 'M63 28 C65 20 71 15 79 15 C74 21 72 25 70 30 Z' },
    { id: 'skull', parent: 'head', shape: 'circle', fill: 'green', cx: 60, cy: 52, r: 28 },
    { id: 'cheekL', parent: 'head', shape: 'ellipse', fill: 'cheek', cx: 40, cy: 61, rx: 5.5, ry: 3.2 },
    { id: 'cheekR', parent: 'head', shape: 'ellipse', fill: 'cheek', cx: 80, cy: 61, rx: 5.5, ry: 3.2 },

    { id: 'eyesOpen', parent: 'head', shape: 'group' },
    { id: 'eyeWhiteL', parent: 'eyesOpen', shape: 'circle', fill: 'eyeWhite', cx: 46, cy: 48, r: 7 },
    { id: 'pupilL', parent: 'eyesOpen', shape: 'circle', fill: 'pupil', cx: 47, cy: 49, r: 4.3 },
    { id: 'glintL', parent: 'eyesOpen', shape: 'circle', fill: 'glint', cx: 45.4, cy: 47, r: 1.5 },
    { id: 'eyeWhiteR', parent: 'eyesOpen', shape: 'circle', fill: 'eyeWhite', cx: 74, cy: 48, r: 7 },
    { id: 'pupilR', parent: 'eyesOpen', shape: 'circle', fill: 'pupil', cx: 73, cy: 49, r: 4.3 },
    { id: 'glintR', parent: 'eyesOpen', shape: 'circle', fill: 'glint', cx: 71.4, cy: 47, r: 1.5 },
    { id: 'eyesClosed', parent: 'head', shape: 'path', stroke: 'ink', strokeWidth: 2, linecap: 'round', hidden: true, d: 'M39 49 Q46 54 53 49 M67 49 Q74 54 81 49' },
    { id: 'eyesHappy', parent: 'head', shape: 'path', stroke: 'ink', strokeWidth: 2, linecap: 'round', hidden: true, d: 'M39 51 Q46 43 53 51 M67 51 Q74 43 81 51' },
    { id: 'eyesDizzy', parent: 'head', shape: 'group', hidden: true },
    { id: 'swirlL', parent: 'eyesDizzy', shape: 'path', stroke: 'ink', strokeWidth: 1.5, linecap: 'round', d: 'M46 48 m-6 0 a6 6 0 1 0 12 0 a4.5 4.5 0 1 0 -9 0 a3 3 0 1 0 6 0' },
    { id: 'swirlR', parent: 'eyesDizzy', shape: 'path', stroke: 'ink', strokeWidth: 1.5, linecap: 'round', d: 'M74 48 m-6 0 a6 6 0 1 0 12 0 a4.5 4.5 0 1 0 -9 0 a3 3 0 1 0 6 0' },

    /* 叼着的唱片(busy):画在喙下面,喙尖压住唱片上沿 */
    { id: 'record', parent: 'head', shape: 'group', hidden: true },
    { id: 'recordDisc', parent: 'record', shape: 'circle', fill: 'vinyl', cx: 60, cy: 81, r: 11 },
    { id: 'recordGroove', parent: 'record', shape: 'circle', stroke: 'vinylGroove', strokeWidth: 0.7, cx: 60, cy: 81, r: 8 },
    { id: 'recordLabel', parent: 'record', shape: 'circle', fill: 'vinylLabel', cx: 60, cy: 81, r: 3.8 },
    { id: 'recordHole', parent: 'record', shape: 'circle', fill: 'vinyl', cx: 60, cy: 81, r: 0.9 },

    /* 喙:下喙两态(闭 / 张),上喙永远在最上面 */
    { id: 'mouthInside', parent: 'head', shape: 'ellipse', fill: 'mouthIn', hidden: true, cx: 60, cy: 68, rx: 4.5, ry: 3.5 },
    { id: 'beakLower', parent: 'head', shape: 'path', fill: 'beakDark', d: 'M54 64 Q60 70 66 64 Q64 71 60 72 Q56 71 54 64 Z' },
    { id: 'beakLowerOpen', parent: 'head', shape: 'path', fill: 'beakDark', hidden: true, origin: [50, 0], d: 'M53 66 Q60 73 67 66 Q66 77 60 79 Q54 77 53 66 Z' },
    { id: 'beakUpper', parent: 'head', shape: 'path', fill: 'beak', d: 'M50 56 Q51 47 60 46 Q69 47 70 56 Q69 64 61 71 Q60 73 59 71 Q51 64 50 56 Z' },
    { id: 'nostrils', parent: 'head', shape: 'path', stroke: 'beakDark', strokeWidth: 1.6, linecap: 'round', d: 'M56 51.5 L56.1 51.5 M64 51.5 L64.1 51.5' },
    { id: 'beakGloss', parent: 'head', shape: 'path', stroke: 'beakShine', strokeWidth: 1.2, linecap: 'round', d: 'M54 53 Q56.5 49.5 60 49' },

    /* 盖住头的那片翅膀(sleeping) */
    {
      id: 'wingTuck',
      parent: 'body',
      shape: 'path',
      fill: 'greenDark',
      hidden: true,
      d: 'M92 104 C101 80 91 55 67 52 C53 51 42 59 40 71 C48 67 56 70 60 76 C52 80 48 88 50 95 C58 90 66 92 71 99 C71 104 77 108 85 108 Z',
    },

    /* 脚 */
    { id: 'footL', shape: 'ellipse', fill: 'feet', cx: 50, cy: 128, rx: 6, ry: 3 },
    { id: 'footR', shape: 'ellipse', fill: 'feet', cx: 70, cy: 128, rx: 6, ry: 3, origin: [50, 100] },

    /* z 与爱心 */
    { id: 'zz', shape: 'group', hidden: true },
    { id: 'z1', parent: 'zz', shape: 'path', stroke: 'zz', strokeWidth: 1.8, linecap: 'round', d: 'M88 28 L94 28 L88 35 L94 35' },
    { id: 'z2', parent: 'zz', shape: 'path', stroke: 'zz', strokeWidth: 2, linecap: 'round', d: 'M98 14 L105 14 L98 22 L105 22' },
    { id: 'hearts', shape: 'group', hidden: true },
    { id: 'heartA', parent: 'hearts', shape: 'path', fill: 'heart', d: 'M94 34 c-3-4-9-1-6 4 l6 6 6-6 c3-5-3-8-6-4z' },
    { id: 'heartB', parent: 'hearts', shape: 'path', fill: 'heart', d: 'M104 22 c-2-3-7-1-5 3 l5 5 5-5 c2-4-3-6-5-3z' },
    { id: 'heartC', parent: 'hearts', shape: 'path', fill: 'heart', d: 'M26 30 c-2-3-7-1-5 3 l5 5 5-5 c2-4-3-6-5-3z' },
  ],
  poses: {
    sitting: {
      parts: { tail: { motion: 'sway' } },
    },
    grooving: {
      parts: {
        body: { motion: 'swayFast' },
        crest: { motion: 'bob' },
        footR: { motion: 'tap' },
        tail: { motion: 'swayFast' },
      },
    },
    speaking: {
      parts: {
        head: { transform: { translate: [0, -3] } },
        crest: { transform: { scale: 1.12, rotate: -4 } },
        tail: { motion: 'sway' },
      },
    },
    busy: {
      parts: {
        head: { transform: { translate: [6, 3], rotate: 14 } },
        record: { hidden: false },
        crest: { transform: { rotate: 8 } },
      },
    },
    listening: {
      parts: {
        head: { transform: { translate: [-2, 1], rotate: -16 } },
        crest: { motion: 'twitch' },
        tail: { motion: 'sway' },
      },
    },
    dozing: {
      parts: {
        head: { transform: { translate: [0, 5], rotate: -5 } },
        eyesOpen: { hidden: true },
        eyesClosed: { hidden: false },
        body: { motion: 'breathe' },
        zz: { hidden: false, motion: 'floatUp' },
      },
    },
    sleeping: {
      parts: {
        head: { transform: { translate: [-6, 20], rotate: -26, scale: 0.9 } },
        eyesOpen: { hidden: true },
        eyesClosed: { hidden: false },
        wingR: { hidden: true },
        wingTuck: { hidden: false },
        body: { motion: 'breathe' },
        zz: { hidden: false, motion: 'floatUp' },
      },
    },
    dizzy: {
      parts: {
        puff: { hidden: false, transform: { scale: 1.04 } },
        eyesOpen: { hidden: true },
        eyesDizzy: { hidden: false },
        swirlL: { motion: 'spin' },
        swirlR: { motion: 'spin' },
        head: { motion: 'wobble' },
        crest: { transform: { scale: [1.25, 1.2] } },
        wingL: { transform: { rotate: 10 } },
        wingR: { transform: { rotate: -10 } },
      },
    },
    petted: {
      parts: {
        head: { transform: { translate: [0, 2], rotate: 9 } },
        eyesOpen: { hidden: true },
        eyesHappy: { hidden: false },
        cheekL: { transform: { scale: 1.35 } },
        cheekR: { transform: { scale: 1.35 } },
        purrL: { hidden: false, motion: 'purr' },
        purrR: { hidden: false, motion: 'purr' },
        tail: { motion: 'swayFast' },
      },
    },
  },
  mouth: { closed: ['beakLower'], talking: ['beakLowerOpen', 'mouthInside'] },
  oneShots: { twitch: 'crest', love: 'hearts' },
}
