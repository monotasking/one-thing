/**
 * MCP type-convergence guard.
 *
 * The MCP base types used to be copy-pasted in four places
 * (`packages/core/mcp/types.ts`, this package, `useMCPServers.ts`,
 * `mcpPresets.ts`). They now all re-export from `@onething/core/mcp` — the
 * engine is the single source of truth. This test pins that contract:
 *
 * 1. compile-time: shared/ipc re-exports are *identical* to the core types
 *    (a divergence fails `typecheck:node`, not just vitest);
 * 2. tripwire: the transport union is pinned literally. Widening it in core
 *    (e.g. adding `'http'` for Streamable HTTP) fails here on purpose, so the
 *    change comes with a deliberate checklist: transport plan branch, dialog
 *    option, import inference, presets.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  MCPConnectionStatus as CoreConnectionStatus,
  MCPPromptInfo as CorePromptInfo,
  MCPResourceInfo as CoreResourceInfo,
  MCPServerConfig as CoreServerConfig,
  MCPServerState as CoreServerState,
  MCPSettings as CoreSettings,
  MCPToolCallRequest as CoreToolCallRequest,
  MCPToolCallResult as CoreToolCallResult,
  MCPToolInfo as CoreToolInfo,
  MCPTransportType as CoreTransportType,
} from '../../mcp/types.js'
import type {
  MCPConnectionStatus,
  MCPPromptInfo,
  MCPResourceInfo,
  MCPServerConfig,
  MCPServerState,
  MCPSettings,
  MCPToolCallRequest,
  MCPToolCallResult,
  MCPToolInfo,
  MCPTransportType,
} from '../mcp.js'
import { DEFAULT_MCP_SETTINGS } from '../../mcp/types.js'

describe('MCP type convergence (shared/ipc ↔ core)', () => {
  it('shared/ipc re-exports the exact core types', () => {
    expectTypeOf<MCPTransportType>().toEqualTypeOf<CoreTransportType>()
    expectTypeOf<MCPServerConfig>().toEqualTypeOf<CoreServerConfig>()
    expectTypeOf<MCPConnectionStatus>().toEqualTypeOf<CoreConnectionStatus>()
    expectTypeOf<MCPServerState>().toEqualTypeOf<CoreServerState>()
    expectTypeOf<MCPSettings>().toEqualTypeOf<CoreSettings>()
    expectTypeOf<MCPToolInfo>().toEqualTypeOf<CoreToolInfo>()
    expectTypeOf<MCPResourceInfo>().toEqualTypeOf<CoreResourceInfo>()
    expectTypeOf<MCPPromptInfo>().toEqualTypeOf<CorePromptInfo>()
    expectTypeOf<MCPToolCallRequest>().toEqualTypeOf<CoreToolCallRequest>()
    expectTypeOf<MCPToolCallResult>().toEqualTypeOf<CoreToolCallResult>()
  })

  it('transport union is pinned — widening it requires a deliberate checklist', () => {
    // Streamable HTTP landed (P1-1): `'http'` joined the union together with
    // the transport-plan branch, both SDK call sites, the dialog option, and
    // the import inference default (url ⇒ http unless explicit `type: 'sse'`).
    // The NEXT transport addition must repeat that checklist.
    expectTypeOf<MCPTransportType>().toEqualTypeOf<'stdio' | 'sse' | 'http'>()
    expectTypeOf<MCPConnectionStatus>().toEqualTypeOf<
      'disconnected' | 'connecting' | 'connected' | 'error'
    >()
  })

  it('DEFAULT_MCP_SETTINGS matches the MCPSettings shape at runtime', () => {
    const settings: MCPSettings = DEFAULT_MCP_SETTINGS
    // flatToolThreshold 20 is the hybrid-mode default (决策点 #1); 0 pins the
    // pre-hybrid router-only behavior.
    expect(settings).toEqual({ enabled: true, servers: [], flatToolThreshold: 20 })
  })
})
