# Collaboration execution ownership

Product ownership is the persisted `ownerUserId` / `ownerWorkspaceId` pair.
An agent identity or an IM sender is not a product-account principal.

The internal room actor activation captures the room's persisted ownership once.
The actor keeps this immutable context when creating execution/work sessions,
driving the engine, and returning results. Each action checks the room and actual
target sessions again. An ownership change rejects the old actor; it does not
refresh that actor's identity from a request's target session.

Tool calls receive the already authorized execution context through a separate
invocation option. `send_message`, private-room creation, and delayed wake posts
carry that context without accepting identity fields from tool arguments.

Local-user/default retains existing private-room and agent-execution IDs.
For every other owner, new creation and lookup derive an ID from SHA-256 of the
JSON tuple `[legacyId, userId, workspaceId]`. This preserves tuple boundaries and
keeps the same agents independent across users and tenants. Existing non-default
rooms with old IDs remain stored; they are not silently reassigned or migrated.
Namespacing never replaces authorization of an existing record.

Room-history clearing freezes its room, member execution, optional pair-room,
and currently running stop targets before the first side effect. It checks the
whole set before aborting or clearing anything and rejects newly expanded stop
targets during asynchronous waits. Gateway-created sessions currently belong
to the fixed local-user/default operator; remote IM IDs only describe origins.

History tools filter room metadata by the trusted invocation owner before reading
any transcript. Room names, result counts, and explicit-room alternatives use the
same authorized set. Board tools carry the context separately from arguments and
recheck source and target inside the room's serialized board-write queue.

Notebooks are shared across an agent's rooms only within one product owner and
tenant. Local-user/default keeps the historical agent notebook file; other owners
use `owned-collab-notebooks/<sha256(JSON([userId, workspaceId, agentId]))>/notebook.md`.
Actor reads use the immutable room-activation context and reject ownership changes.
Unscoped actor notes cannot select an owner and are rejected. Legacy notebooks are
neither copied into another owner's scope nor rewritten during this change.

External-agent host tools receive the same trusted execution context through the
provider, connector, and in-process MCP binding. Model arguments cannot supply or
override it, and actual source/target authorization still runs in each tool.
Each MCP definition captures its turn binding. Calls after release or replacement
of that binding fail before invoking the tool, even when the session ID is reused.
