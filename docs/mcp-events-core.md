# Generic MCP Events core

The public server entry point is `server/events-core.js`, with declarations in
`server/events-core.d.ts`. It exports the generic service, durable stores,
stateless HTTP handler, and public HTTPS webhook transport. The API does not
select a DM, read another module's settings, launch a tunnel, or define combat
events.

An integration supplies an `EventDefinition` containing its event name, schemas,
canonical event identity, filter matching, occurrence validation, and scope
matching. It also supplies independently authenticated subscription and ingress
authorization callbacks, a delivery authorization callback, private storage
verification, and a protected secret codec. Construction performs no network
requests or timer work; the integration explicitly runs bounded delivery passes.

`FileEventStore(path, assertPrivateStorage, definition)` preserves storage version
1 and opaque `dot1` cursors from existing installations. A service handles one
event definition and one durable store. The same definition and canonical filter
algorithm must be supplied when reopening that store. Accepted delivery records
are retained for deduplication; expiry-cancelled records can resume from an
explicit saved cursor without resetting attempts or retry deadlines.

`mountMcpEvents(app, path, options)` mounts only the caller-selected scoped route.
The caller supplies authentication, principal-to-scope resolution, and a scoped
tool catalog. Dynamic options keep the route unavailable until the integration
explicitly publishes a runtime. The ordinary administrative MCP catalog and
its authentication are separate.

Webhook verification and delivery enforce public HTTPS, fresh pinned DNS,
bounded payloads/timeouts, exact Standard Webhooks signatures, and no redirects.
Callbacks must first echo a single-use verification challenge. Security failures
are reported with fixed messages that do not contain credentials or callback
URLs.
