import { describe, expect, it } from 'vitest'
import {
  projectOnethingPluginCommandsForRenderer,
  projectOnethingPluginsForRenderer,
} from '../plugin-list.js'

describe('projectOnethingPluginsForRenderer', () => {
  it('projects loaded plugin state into renderer-safe plugin info', () => {
    expect(projectOnethingPluginsForRenderer([
      {
        definition: {
          id: 'demo',
          source: 'builtin',
          manifest: {
            name: 'Demo',
            version: '1.2.3',
            description: 'Demo plugin',
            author: 'onething',
            minAppVersion: '1.0.0',
            contributes: {
              commands: [{ name: '/demo' }],
              panels: [{ id: 'demo-panel', label: 'Demo' }],
              settings: {
                title: 'Demo settings',
                schema: {
                  type: 'object',
                  properties: { verbose: { type: 'boolean', default: false } },
                },
              },
              permissions: ['files:read'],
              activation: { events: ['onCommand:/demo'] },
            },
          },
          enabled: true,
          dirPath: 'builtin://demo',
        },
        loaded: false,
        commands: ['/demo'],
        error: 'install deps',
        health: {
          status: 'disabled',
          consecutiveFailures: 3,
          lastError: 'boom',
          lastErrorScope: 'promptContext:notes',
          disabledReason: '3 consecutive failures (last: promptContext:notes — boom)',
        },
      },
    ], {
      getRequestActions: () => ['search'],
      getConfig: () => ({ verbose: true }),
    })).toEqual([
      {
        id: 'demo',
        source: 'builtin',
        name: 'Demo',
        version: '1.2.3',
        description: 'Demo plugin',
        author: 'onething',
        loaded: false,
        enabled: true,
        commands: ['/demo'],
        error: 'install deps',
        dirPath: 'builtin://demo',
        contributes: {
          commands: ['/demo'],
          // C 期:面板逐条带形态与判决(缺省 descriptor,声明合法)。
          panels: [{
            id: 'demo-panel',
            label: 'Demo',
            view: 'descriptor',
            entry: '',
            unsupported: false,
            reason: '',
            // H1:未声明 placements → 缺省 ['workspace'](只在主工作区)。
            placements: ['workspace'],
          }],
          hasSettingsSchema: true,
          permissions: ['files:read'],
          activationEvents: ['onCommand:/demo'],
          uiSlots: [],
          theme: [],
          skin: [],
          background: null,
          ambient: null,
        },
        requestActions: ['search'],
        configFields: [{
          key: 'verbose',
          type: 'boolean',
          control: 'switch',
          label: 'Verbose',
          hint: undefined,
          required: false,
          defaultValue: false,
        }],
        configTitle: 'Demo settings',
        configValues: { verbose: true },
        configUnsupportedReasons: [],
        configValuesAreDefaults: false,
        configEditable: true,
        minAppVersion: '1.0.0',
        healthStatus: 'disabled',
        healthFailures: 3,
        healthReason: '3 consecutive failures (last: promptContext:notes — boom)',
        degradedSurfaces: [],
      },
    ])
  })

  it('carries declared placements through, filtering non-strings (H1)', () => {
    const projected = projectOnethingPluginsForRenderer([
      {
        definition: {
          id: 'demo',
          manifest: {
            name: 'Demo',
            version: '1.0.0',
            contributes: {
              panels: [
                { id: 'both', label: 'Both', placements: ['workspace', 'workbench'] },
                // 空数组 → 缺省;含非字符串 → 过滤后再判空。
                { id: 'legacy', label: 'Legacy' },
              ],
            },
          },
          enabled: true,
          dirPath: '/plugins/demo',
        },
        loaded: true,
        commands: [],
      },
    ])
    expect(projected[0].contributes.panels[0].placements).toEqual(['workspace', 'workbench'])
    // 未声明 = 只在主工作区(append-only,老面板零变化)。
    expect(projected[0].contributes.panels[1].placements).toEqual(['workspace'])
  })

  it('falls back to the last runtime error when the breaker has not tripped', () => {
    expect(projectOnethingPluginsForRenderer([
      {
        definition: {
          id: 'demo',
          manifest: { name: 'Demo', version: '1.0.0' },
          enabled: true,
          dirPath: '/plugins/demo',
        },
        loaded: true,
        commands: [],
        health: {
          status: 'degraded',
          consecutiveFailures: 1,
          lastError: 'timed out',
          lastErrorScope: 'promptContext:notes (timeout)',
        },
      },
    ])[0]).toMatchObject({
      healthStatus: 'degraded',
      healthFailures: 1,
      healthReason: 'promptContext:notes (timeout): timed out',
      degradedSurfaces: [],
    })
  })

  it('uses renderer defaults for optional plugin fields', () => {
    expect(projectOnethingPluginsForRenderer([
      {
        definition: {
          id: 'user-plugin',
          manifest: {
            name: 'User Plugin',
            version: '0.1.0',
          },
          enabled: false,
          dirPath: '/plugins/user-plugin',
        },
        loaded: true,
        commands: [],
      },
    ])).toEqual([
      {
        id: 'user-plugin',
        source: 'user',
        name: 'User Plugin',
        version: '0.1.0',
        description: '',
        author: '',
        loaded: true,
        enabled: false,
        commands: [],
        error: '',
        dirPath: '/plugins/user-plugin',
        contributes: {
          commands: [],
          panels: [],
          hasSettingsSchema: false,
          uiSlots: [],
          theme: [],
          skin: [],
          background: null,
          ambient: null,
          permissions: [],
          activationEvents: [],
        },
        requestActions: [],
        configFields: [],
        configTitle: '',
        configValues: {},
        configUnsupportedReasons: [],
        configValuesAreDefaults: false,
        configEditable: false,
        minAppVersion: '',
        healthStatus: 'healthy',
        healthFailures: 0,
        healthReason: '',
        degradedSurfaces: [],
      },
    ])
  })

  it('projects plugin slash commands for renderer lists', () => {
    expect(projectOnethingPluginCommandsForRenderer([
      { name: '/demo', description: 'Run demo', usage: '/demo arg' },
      { name: '/brief' },
    ])).toEqual([
      {
        id: 'demo',
        name: '/demo',
        description: 'Run demo',
        usage: '/demo arg',
      },
      {
        id: 'brief',
        name: '/brief',
        description: 'Plugin command',
        usage: '/brief',
      },
    ])
  })
})
