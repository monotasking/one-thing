import { registerCapability } from '@onething/runtime/permissions'
import { todoPlanStore } from '../todo-plan/store.js'

/**
 * The capabilities this app ships with — see docs/design/capability-registry.md.
 *
 * Each one answers "which directory may the assistant act on without being asked
 * every time", in a form that settings can list and switch off. Directories are
 * resolvers, not strings: the todo directory is a user setting and can move
 * while the app is running.
 *
 * Deliberately the two managed subdirectories rather than the todo root — the
 * root comes from a free-text setting, so keeping it out bounds the damage of a
 * careless value to directories the app itself created.
 */
export function registerBuiltinCapabilities(): void {
  // The AI keeps its todo with the ordinary write/edit tools, so without this
  // every ticked checkbox would be a permission prompt.
  registerCapability({
    id: 'todo.sessions',
    label: 'AI todo',
    directory: () => todoPlanStore.sessionsDirectory(),
    actions: ['read', 'write'],
    authority: 'builtin',
  })

  registerCapability({
    id: 'todo.user-notes',
    label: 'Todo notes',
    directory: () => todoPlanStore.userNotesDirectory(),
    actions: ['read', 'write'],
    authority: 'builtin',
  })
}
