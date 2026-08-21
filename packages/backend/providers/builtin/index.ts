/**
 * Built-in Provider Definitions
 *
 * This file exports all built-in provider definitions.
 * To add a new provider:
 * 1. Create a new file in this directory (e.g., myprovider.ts)
 * 2. Export it from this file
 * 3. Register a matching AgentProvider runtime in
 *    src/main/agent-loop/providers/factory.ts
 *
 * Built-in providers are expected to route through agent runtimes by default.
 */

import {
  acpBuiltinProvider,
  claudeCodeAgentBuiltinProvider,
  ONETHING_CODEX_PROVIDER_ID,
  onethingPortableBuiltinProviders,
} from '@onething/runtime/providers'
import codex from './codex.js'

import type { ProviderDefinition } from '../types.js'

// All built-in providers
export const builtinProviders: ProviderDefinition[] = [
  ...onethingPortableBuiltinProviders
    .filter(provider => provider.id !== ONETHING_CODEX_PROVIDER_ID) as ProviderDefinition[],
  codex,
  acpBuiltinProvider as ProviderDefinition,
  claudeCodeAgentBuiltinProvider as ProviderDefinition,
]

export default builtinProviders
