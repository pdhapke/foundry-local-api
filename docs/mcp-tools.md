# MCP Tool Catalog

Generated from `allEndpointDescriptors` (server/src/endpoints/index.ts) by `server/src/scripts/generate-docs.ts` — do not hand-edit; run `npm run generate:docs` (from `server/`, or `npm run generate:docs --workspace=server` from the repo root) to regenerate. Every tool listed here is also a REST endpoint with the same input shape — see `docs/openapi.json` and the root README's Examples section.

Total tools: **197**.

## Contents

- [actors](#actors)
- [canvas](#canvas)
- [cards](#cards)
- [chat](#chat)
- [combats](#combats)
- [documents](#documents)
- [enrich-html](#enrich-html)
- [events](#events)
- [files](#files)
- [folders](#folders)
- [game](#game)
- [items](#items)
- [journal-entries](#journal-entries)
- [localize](#localize)
- [macros](#macros)
- [meta](#meta)
- [modules](#modules)
- [notify](#notify)
- [packs](#packs)
- [playlists](#playlists)
- [roll-tables](#roll-tables)
- [rolls](#rolls)
- [scenes](#scenes)
- [search](#search)
- [settings](#settings)
- [status](#status)
- [system](#system)
- [user](#user)
- [users](#users)
- [world](#world)
- [world-time](#world-time)
- [Integration: dnd5e](#integration-dnd5e-system)
- [Integration: digital-tabletops](#integration-digital-tabletops-module)

## actors

### `foundry_create_actor`

Creates a new Actor document.

REST: `POST /api/actors`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_create_actor_effect`

Creates a new embedded ActiveEffect document on a Actor.

REST: `POST /api/actors/:parentId/effects`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_actor_item`

Creates a new embedded Item document on an actor.

REST: `POST /api/actors/:actorId/items`

| Field | Type | Required | Description |
|---|---|---|---|
| `actorId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_delete_actor`

Deletes a Actor document by id.

REST: `DELETE /api/actors/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_delete_actor_effect`

Deletes an embedded ActiveEffect document from a Actor by id.

REST: `DELETE /api/actors/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |

### `foundry_delete_actor_item`

Deletes an embedded Item document from an actor by id.

REST: `DELETE /api/actors/:actorId/items/:itemId`

| Field | Type | Required | Description |
|---|---|---|---|
| `actorId` | string | yes |  |
| `itemId` | string | yes |  |

### `foundry_get_actor`

Reads a single Actor document by id.

REST: `GET /api/actors/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_actor_effect`

Reads a single embedded ActiveEffect document from a Actor by id.

REST: `GET /api/actors/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |

### `foundry_get_actor_item`

Reads a single embedded Item document from an actor by id.

REST: `GET /api/actors/:actorId/items/:itemId`

| Field | Type | Required | Description |
|---|---|---|---|
| `actorId` | string | yes |  |
| `itemId` | string | yes |  |

### `foundry_get_actor_roll_data`

Reads an actor's system-specific roll data (Actor#getRollData()).

REST: `GET /api/actors/:id/roll-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_actor_effects`

Lists every embedded ActiveEffect document on a Actor.

REST: `GET /api/actors/:parentId/effects`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |

### `foundry_list_actor_items`

Lists an actor's embedded Item documents.

REST: `GET /api/actors/:id/items`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_actors`

Lists every Actor document in the current world.

REST: `GET /api/actors`

_No input._

### `foundry_update_actor`

Updates fields on an existing Actor document.

REST: `PUT /api/actors/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_actor_effect`

Updates fields on an existing embedded ActiveEffect document on a Actor.

REST: `PUT /api/actors/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_actor_item`

Updates fields on an existing embedded Item document on an actor.

REST: `PUT /api/actors/:actorId/items/:itemId`

| Field | Type | Required | Description |
|---|---|---|---|
| `actorId` | string | yes |  |
| `itemId` | string | yes |  |
| `changes` | object | yes |  |

## canvas

### `foundry_get_canvas_selection`

Reads the currently controlled/selected tokens on the connected client's canvas (canvas.tokens.controlled), plus the currently-viewed scene id.

REST: `GET /api/canvas/selection`

_No input._

### `foundry_get_targets`

Reads the tokens currently targeted by the connected client's user (game.user.targets), plus the currently-viewed scene id.

REST: `GET /api/canvas/targets`

_No input._

### `foundry_pan_canvas`

Pans/zooms the currently-viewed canvas on the connected client. Omitted x/y/scale keep their current value.

REST: `POST /api/canvas/pan`

| Field | Type | Required | Description |
|---|---|---|---|
| `x` | number | no |  |
| `y` | number | no |  |
| `scale` | number | no |  |

### `foundry_push_view_to_players`

Pans/zooms every connected client's canvas (GM and players alike) to the same view, via a module-scoped socket broadcast — unlike foundry_pan_canvas, which only moves the connected client's own camera. Omitted x/y/scale keep each client's current value.

REST: `POST /api/canvas/push-view`

| Field | Type | Required | Description |
|---|---|---|---|
| `x` | number | no |  |
| `y` | number | no |  |
| `scale` | number | no |  |

### `foundry_set_targets`

Targets the given tokens for the connected client's user, replacing any existing targets unless `additive` is true.

REST: `POST /api/canvas/targets`

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenIds` | array | yes |  |
| `additive` | boolean | no |  |

## cards

### `foundry_create_cards_stack`

Creates a new Cards document.

REST: `POST /api/cards`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_deal_cards`

Deals cards from a Cards stack to one or more destination stacks in cyclical order (e.g. dealing a hand to each player).

REST: `POST /api/cards/:id/deal`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `toIds` | array | yes |  |
| `number` | integer | no |  |

### `foundry_delete_cards_stack`

Deletes a Cards document by id.

REST: `DELETE /api/cards/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_draw_cards`

Draws one or more cards from a source Cards stack (e.g. a deck) into this one.

REST: `POST /api/cards/:id/draw`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `sourceId` | string | yes |  |
| `number` | integer | no |  |

### `foundry_get_cards_stack`

Reads a single Cards document by id.

REST: `GET /api/cards/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_cards_stacks`

Lists every Cards document in the current world.

REST: `GET /api/cards`

_No input._

### `foundry_pass_cards`

Moves specific cards out of a Cards stack and into another one.

REST: `POST /api/cards/:id/pass`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `toId` | string | yes |  |
| `cardIds` | array | yes |  |

### `foundry_reset_cards`

Resets a Cards stack, recalling every card dealt out of it back into this stack.

REST: `POST /api/cards/:id/reset`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_shuffle_cards`

Shuffles a Cards stack in place, randomizing its cards' order.

REST: `POST /api/cards/:id/shuffle`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_update_cards_stack`

Updates fields on an existing Cards document.

REST: `PUT /api/cards/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## chat

### `foundry_delete_chat_message`

Deletes a chat message by id.

REST: `DELETE /api/chat/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_chat_messages`

Lists recent chat log messages, oldest first. Optionally capped by `limit`.

REST: `GET /api/chat`

| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no |  |

### `foundry_send_chat_message`

Posts a new message to the chat log (e.g. { "content": "Hello!" }).

REST: `POST /api/chat`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_update_chat_message`

Updates fields on an existing chat message.

REST: `PUT /api/chat/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## combats

### `foundry_add_combatant`

Adds a new embedded Combatant to a combat (e.g. from a token/actor).

REST: `POST /api/combats/:id/combatants`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `data` | object | yes |  |

### `foundry_combat_next_round`

Advances a combat to the next round.

REST: `POST /api/combats/:id/next-round`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_combat_next_turn`

Advances a combat to the next turn.

REST: `POST /api/combats/:id/next-turn`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_combat_previous_round`

Steps a combat back to the previous round.

REST: `POST /api/combats/:id/previous-round`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_combat_previous_turn`

Steps a combat back to the previous turn.

REST: `POST /api/combats/:id/previous-turn`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_create_combat`

Creates a new Combat document.

REST: `POST /api/combats`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_combat`

Deletes a Combat document by id.

REST: `DELETE /api/combats/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_end_combat`

Ends a combat encounter (deletes it).

REST: `POST /api/combats/:id/end`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_combat`

Reads a single Combat document by id.

REST: `GET /api/combats/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_combats`

Lists every Combat document in the current world.

REST: `GET /api/combats`

_No input._

### `foundry_remove_combatant`

Removes an embedded Combatant from a combat by id.

REST: `DELETE /api/combats/:id/combatants/:combatantId`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `combatantId` | string | yes |  |

### `foundry_roll_combat_initiative`

Rolls initiative for the given combatant ids, or for every combatant missing initiative if no ids are given.

REST: `POST /api/combats/:id/roll-initiative`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `combatantIds` | array | no |  |

### `foundry_start_combat`

Starts a combat encounter, setting round 1 and rolling the initial turn order.

REST: `POST /api/combats/:id/start`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_update_combat`

Updates fields on an existing Combat document.

REST: `PUT /api/combats/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_combatant`

Updates fields on an embedded Combatant (e.g. defeated, hidden, initiative, name override).

REST: `PUT /api/combats/:id/combatants/:combatantId`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `combatantId` | string | yes |  |
| `data` | object | yes |  |

## documents

### `foundry_batch_create_documents`

Creates many documents of the given type in one call.

REST: `POST /api/documents/batch-create`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `items` | array | yes |  |

### `foundry_batch_delete_documents` ⚠️ **destructive**

Permanently deletes every document of the given type whose id is listed. This cannot be undone — use with care.

REST: `POST /api/documents/batch-delete`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `ids` | array | yes |  |

### `foundry_batch_update_documents`

Updates many documents of the given type in one call, each identified by its own id.

REST: `POST /api/documents/batch-update`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `updates` | array | yes |  |

### `foundry_get_document_ownership`

Reads a document's ownership map (default level plus any per-user overrides).

REST: `GET /api/documents/:documentType/:documentId/ownership`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `documentId` | string | yes |  |

### `foundry_query_documents`

Lists documents of the given type, filtered by exact-match equality on top-level fields (e.g. {"name": "Goblin"}), optionally capped to `limit` results.

REST: `POST /api/documents/query`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `filter` | object | no |  |
| `limit` | integer | no |  |

### `foundry_set_document_ownership`

Sets a document's ownership map. Pass a full replacement map (e.g. { "default": 0, "<userId>": 3 }) using CONST.DOCUMENT_OWNERSHIP_LEVELS values. GM only.

REST: `PUT /api/documents/:documentType/:documentId/ownership`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `documentId` | string | yes |  |
| `ownership` | object | yes |  |

## enrich-html

### `foundry_enrich_html`

Enriches raw HTML/content-link text (e.g. @UUID[...], @Actor[...], inline rolls) into resolved HTML via Foundry's TextEditor.enrichHTML().

REST: `POST /api/enrich-html`

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes |  |

## events

### `foundry_get_recent_events`

Reads the most recently published Foundry hook events (createActor, updateToken, etc.) from a bounded in-memory buffer — a polling alternative to the live-streaming GET /api/events SSE endpoint, for MCP clients without a subscribe-to-a-stream primitive. Optional `limit` caps how many of the most recent events are returned.

REST: `GET /api/events/recent`

| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no |  |

## files

### `foundry_browse_files`

Lists the directories and files under a FilePicker path (default source "data", default target the root).

REST: `GET /api/files/browse`

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | no |  |
| `target` | string | no |  |

### `foundry_create_file_directory`

Creates a new directory under a FilePicker source.

REST: `POST /api/files/directories`

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | no |  |
| `target` | string | yes |  |

### `foundry_upload_file`

Uploads a file (base64-encoded content) to a FilePicker directory, subject to Foundry's own upload security model (allowed extensions, size limits, source permissions).

REST: `POST /api/files/upload`

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | no |  |
| `path` | string | yes |  |
| `fileName` | string | yes |  |
| `contentBase64` | string | yes |  |
| `mimeType` | string | no |  |

## folders

### `foundry_create_folder`

Creates a new Folder document.

REST: `POST /api/folders`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_folder`

Deletes a Folder document by id.

REST: `DELETE /api/folders/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_folder`

Reads a single Folder document by id.

REST: `GET /api/folders/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_folders`

Lists every Folder document in the current world.

REST: `GET /api/folders`

_No input._

### `foundry_move_document_to_folder`

Moves any folder-capable document (Actor, Item, JournalEntry, Scene, Macro, Playlist, RollTable, Cards, or a Folder itself to renest it) into a folder by id, or to the root when folderId is null.

REST: `POST /api/folders/move-document`

| Field | Type | Required | Description |
|---|---|---|---|
| `documentType` | string | yes |  |
| `id` | string | yes |  |
| `folderId` | any | yes |  |

### `foundry_update_folder`

Updates fields on an existing Folder document.

REST: `PUT /api/folders/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## game

### `foundry_get_game_paused`

Whether the game is currently paused (the "GAME PAUSED" banner) for every connected client.

REST: `GET /api/game/paused`

_No input._

### `foundry_set_game_paused`

Pauses or unpauses the game for every connected client (the "GAME PAUSED" banner), broadcast from the connected GM user. Returns the resulting paused state.

REST: `POST /api/game/paused`

| Field | Type | Required | Description |
|---|---|---|---|
| `paused` | boolean | yes |  |

## items

### `foundry_create_item`

Creates a new Item document.

REST: `POST /api/items`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_create_item_effect`

Creates a new embedded ActiveEffect document on a Item.

REST: `POST /api/items/:parentId/effects`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_delete_item`

Deletes a Item document by id.

REST: `DELETE /api/items/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_delete_item_effect`

Deletes an embedded ActiveEffect document from a Item by id.

REST: `DELETE /api/items/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |

### `foundry_get_item`

Reads a single Item document by id.

REST: `GET /api/items/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_item_effect`

Reads a single embedded ActiveEffect document from a Item by id.

REST: `GET /api/items/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |

### `foundry_list_item_effects`

Lists every embedded ActiveEffect document on a Item.

REST: `GET /api/items/:parentId/effects`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |

### `foundry_list_items`

Lists every Item document in the current world.

REST: `GET /api/items`

_No input._

### `foundry_update_item`

Updates fields on an existing Item document.

REST: `PUT /api/items/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_item_effect`

Updates fields on an existing embedded ActiveEffect document on a Item.

REST: `PUT /api/items/:parentId/effects/:effectId`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string | yes |  |
| `effectId` | string | yes |  |
| `changes` | object | yes |  |

## journal-entries

### `foundry_create_journal_entry`

Creates a new JournalEntry document.

REST: `POST /api/journal-entries`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_create_journal_entry_page`

Creates a new embedded JournalEntryPage document on a JournalEntry.

REST: `POST /api/journal-entries/:journalEntryId/pages`

| Field | Type | Required | Description |
|---|---|---|---|
| `journalEntryId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_delete_journal_entry`

Deletes a JournalEntry document by id.

REST: `DELETE /api/journal-entries/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_delete_journal_entry_page`

Deletes an embedded JournalEntryPage document from a JournalEntry by id.

REST: `DELETE /api/journal-entries/:journalEntryId/pages/:pageId`

| Field | Type | Required | Description |
|---|---|---|---|
| `journalEntryId` | string | yes |  |
| `pageId` | string | yes |  |

### `foundry_get_journal_entry`

Reads a single JournalEntry document by id.

REST: `GET /api/journal-entries/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_journal_entry_page`

Reads a single embedded JournalEntryPage document by id.

REST: `GET /api/journal-entries/:journalEntryId/pages/:pageId`

| Field | Type | Required | Description |
|---|---|---|---|
| `journalEntryId` | string | yes |  |
| `pageId` | string | yes |  |

### `foundry_list_journal_entries`

Lists every JournalEntry document in the current world.

REST: `GET /api/journal-entries`

_No input._

### `foundry_list_journal_entry_pages`

Lists a JournalEntry's embedded JournalEntryPage documents.

REST: `GET /api/journal-entries/:journalEntryId/pages`

| Field | Type | Required | Description |
|---|---|---|---|
| `journalEntryId` | string | yes |  |

### `foundry_update_journal_entry`

Updates fields on an existing JournalEntry document.

REST: `PUT /api/journal-entries/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_journal_entry_page`

Updates fields on an existing embedded JournalEntryPage document.

REST: `PUT /api/journal-entries/:journalEntryId/pages/:pageId`

| Field | Type | Required | Description |
|---|---|---|---|
| `journalEntryId` | string | yes |  |
| `pageId` | string | yes |  |
| `changes` | object | yes |  |

## localize

### `foundry_localize`

Resolves a localization key via game.i18n. With `data`, interpolates via game.i18n.format(); without it, plain game.i18n.localize().

REST: `GET /api/localize`

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes |  |
| `data` | string | no |  |

## macros

### `foundry_create_macro`

Creates a new Macro document.

REST: `POST /api/macros`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_macro`

Deletes a Macro document by id.

REST: `DELETE /api/macros/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_execute_macro` ⚠️ **destructive**

Executes a macro by id, running its stored script or chat command with full Foundry client privileges. WARNING: a script-type macro is arbitrary JavaScript — only execute macros you trust, exactly as if you were clicking them on the macro bar yourself.

REST: `POST /api/macros/:id/execute`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_macro`

Reads a single Macro document by id.

REST: `GET /api/macros/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_macros`

Lists every Macro document in the current world.

REST: `GET /api/macros`

_No input._

### `foundry_update_macro`

Updates fields on an existing Macro document.

REST: `PUT /api/macros/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## meta

### `foundry_status`

Foundry Local API server status (mirrors GET /health): liveness, uptime, and server version.

REST: `(MCP only — no REST route)`

_No input._

## modules

### `foundry_list_modules`

Every installed module (id, title, active, version), including inactive ones.

REST: `GET /api/modules`

_No input._

## notify

### `foundry_notify`

Shows a UI notification (toast/banner) on the connected client. `target: "all"` (default "caller") also broadcasts it to every other connected client, GM and players alike, unlike ui.notifications.notify()'s normal client-local-only behavior.

REST: `POST /api/notify`

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes |  |
| `type` | string | no |  |
| `target` | string | no |  |

## packs

### `foundry_create_pack`

Creates a new, empty compendium pack of the given document type.

REST: `POST /api/packs`

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes |  |
| `label` | string | yes |  |
| `name` | string | no |  |

### `foundry_create_pack_entry`

Creates a new entry (document) directly inside a compendium pack.

REST: `POST /api/packs/:packId/entries`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_delete_pack` ⚠️ **destructive**

Deletes an entire compendium pack, including every entry inside it. WARNING: this is destructive and cannot be undone — the pack and all its contents are permanently removed, not just emptied.

REST: `DELETE /api/packs/:packId`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |

### `foundry_delete_pack_entry`

Deletes an entry from a compendium pack by id.

REST: `DELETE /api/packs/:packId/entries/:entryId`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `entryId` | string | yes |  |

### `foundry_duplicate_pack`

Duplicates a compendium pack, including all of its entries, under a new label.

REST: `POST /api/packs/:packId/duplicate`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `label` | string | no |  |

### `foundry_export_adventure`

Assembles world documents (by id, per document type) into a new Adventure compendium entry inside the given pack — the convenience assembly step around creating an Adventure entry by hand.

REST: `POST /api/packs/:packId/adventures`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `name` | string | yes |  |
| `img` | string | no |  |
| `caption` | string | no |  |
| `description` | string | no |  |
| `actorIds` | array | no |  |
| `itemIds` | array | no |  |
| `sceneIds` | array | no |  |
| `journalIds` | array | no |  |
| `macroIds` | array | no |  |
| `tableIds` | array | no |  |
| `cardsIds` | array | no |  |
| `playlistIds` | array | no |  |
| `folderIds` | array | no |  |
| `combatIds` | array | no |  |

### `foundry_get_pack_entry`

Reads a single compendium entry's full document data by id.

REST: `GET /api/packs/:packId/entries/:entryId`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `entryId` | string | yes |  |

### `foundry_get_pack_index`

Reads a compendium pack's index: lightweight entries (id, name, and a few other fields) without loading each full document.

REST: `GET /api/packs/:packId/index`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |

### `foundry_import_adventure` ⚠️ **destructive**

Imports an Adventure compendium entry into the world, creating/updating documents across every world collection the adventure's content covers (actors, scenes, items, journals, etc.) in one bulk operation. WARNING: this can create or overwrite many documents at once.

REST: `POST /api/packs/:packId/adventures/:entryId/import`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `entryId` | string | yes |  |

### `foundry_import_pack_entry`

Imports a compendium entry into the world, creating a new document in the matching world collection.

REST: `POST /api/packs/:packId/entries/:entryId/import`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `entryId` | string | yes |  |

### `foundry_list_packs`

Lists every compendium pack available in the world (id, label, document type, source package).

REST: `GET /api/packs`

_No input._

### `foundry_update_pack_entry`

Updates fields on an existing compendium entry.

REST: `PUT /api/packs/:packId/entries/:entryId`

| Field | Type | Required | Description |
|---|---|---|---|
| `packId` | string | yes |  |
| `entryId` | string | yes |  |
| `changes` | object | yes |  |

## playlists

### `foundry_create_playlist`

Creates a new Playlist document.

REST: `POST /api/playlists`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_playlist`

Deletes a Playlist document by id.

REST: `DELETE /api/playlists/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_playlist`

Reads a single Playlist document by id.

REST: `GET /api/playlists/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_playlists`

Lists every Playlist document in the current world.

REST: `GET /api/playlists`

_No input._

### `foundry_pause_playlist_sound`

Pauses playback of a single sound within a playlist, recording its position so a later play resumes from where it left off.

REST: `POST /api/playlists/:id/sounds/:soundId/pause`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `soundId` | string | yes |  |

### `foundry_play_all_playlist_sounds`

Begins simultaneous playback of every sound in a playlist.

REST: `POST /api/playlists/:id/play-all`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_play_playlist_sound`

Starts playback of a single sound within a playlist.

REST: `POST /api/playlists/:id/sounds/:soundId/play`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `soundId` | string | yes |  |

### `foundry_stop_all_playlist_sounds`

Stops playback of every currently-playing sound in a playlist.

REST: `POST /api/playlists/:id/stop-all`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_stop_playlist_sound`

Stops playback of a single sound within a playlist and resets its position.

REST: `POST /api/playlists/:id/sounds/:soundId/stop`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `soundId` | string | yes |  |

### `foundry_update_playlist`

Updates fields on an existing Playlist document.

REST: `PUT /api/playlists/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## roll-tables

### `foundry_create_roll_table`

Creates a new RollTable document.

REST: `POST /api/roll-tables`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_roll_table`

Deletes a RollTable document by id.

REST: `DELETE /api/roll-tables/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_draw_roll_table`

Draws one result from a RollTable by id, evaluating the table's roll formula and returning the drawn TableResult(s). Posts to chat by default, same as Foundry's own table draw.

REST: `POST /api/roll-tables/:id/draw`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `displayChat` | boolean | no |  |

### `foundry_get_roll_table`

Reads a single RollTable document by id.

REST: `GET /api/roll-tables/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_list_roll_tables`

Lists every RollTable document in the current world.

REST: `GET /api/roll-tables`

_No input._

### `foundry_update_roll_table`

Updates fields on an existing RollTable document.

REST: `PUT /api/roll-tables/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

## rolls

### `foundry_roll_dice`

Evaluates a dice roll formula (e.g. "2d6+3") against Foundry's Roll engine and returns the total, the resolved expression, and individual die results. Does not post to chat.

REST: `POST /api/rolls`

| Field | Type | Required | Description |
|---|---|---|---|
| `formula` | string | yes |  |
| `data` | object | no |  |

## scenes

### `foundry_activate_scene`

Activates a scene, making it the world's current active/viewed scene.

REST: `POST /api/scenes/:id/activate`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_create_scene`

Creates a new Scene document.

REST: `POST /api/scenes`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_create_scene_drawing`

Creates a new embedded Drawing document on a scene.

REST: `POST /api/scenes/:sceneId/drawings`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_light`

Creates a new embedded AmbientLight document on a scene.

REST: `POST /api/scenes/:sceneId/lights`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_note`

Creates a new embedded Note document on a scene.

REST: `POST /api/scenes/:sceneId/notes`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_region`

Creates a new embedded Region document on a scene.

REST: `POST /api/scenes/:sceneId/regions`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_sound`

Creates a new embedded AmbientSound document on a scene.

REST: `POST /api/scenes/:sceneId/sounds`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_template`

Creates a new embedded MeasuredTemplate document on a scene.

REST: `POST /api/scenes/:sceneId/templates`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_token`

Creates a new embedded Token document on a scene.

REST: `POST /api/scenes/:sceneId/tokens`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_create_scene_wall`

Creates a new embedded Wall document on a scene.

REST: `POST /api/scenes/:sceneId/walls`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `data` | object | yes |  |

### `foundry_delete_scene`

Deletes a Scene document by id.

REST: `DELETE /api/scenes/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_delete_scene_drawing`

Deletes an embedded Drawing document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/drawings/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_light`

Deletes an embedded AmbientLight document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/lights/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_note`

Deletes an embedded Note document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/notes/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_region`

Deletes an embedded Region document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/regions/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_sound`

Deletes an embedded AmbientSound document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/sounds/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_template`

Deletes an embedded MeasuredTemplate document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/templates/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_delete_scene_token`

Deletes an embedded Token document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/tokens/:tokenId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `tokenId` | string | yes |  |

### `foundry_delete_scene_wall`

Deletes an embedded Wall document from a scene by id.

REST: `DELETE /api/scenes/:sceneId/walls/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene`

Reads a single Scene document by id.

REST: `GET /api/scenes/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_scene_dimensions`

Reads a scene's grid config and computed pixel dimensions (size, distance, units, width/height).

REST: `GET /api/scenes/:id/dimensions`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_get_scene_drawing`

Reads a single embedded Drawing document from a scene by id.

REST: `GET /api/scenes/:sceneId/drawings/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_light`

Reads a single embedded AmbientLight document from a scene by id.

REST: `GET /api/scenes/:sceneId/lights/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_note`

Reads a single embedded Note document from a scene by id.

REST: `GET /api/scenes/:sceneId/notes/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_region`

Reads a single embedded Region document from a scene by id.

REST: `GET /api/scenes/:sceneId/regions/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_sound`

Reads a single embedded AmbientSound document from a scene by id.

REST: `GET /api/scenes/:sceneId/sounds/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_template`

Reads a single embedded MeasuredTemplate document from a scene by id.

REST: `GET /api/scenes/:sceneId/templates/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_get_scene_token`

Reads a single embedded Token document from a scene by id.

REST: `GET /api/scenes/:sceneId/tokens/:tokenId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `tokenId` | string | yes |  |

### `foundry_get_scene_wall`

Reads a single embedded Wall document from a scene by id.

REST: `GET /api/scenes/:sceneId/walls/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |

### `foundry_list_scene_drawings`

Lists every embedded Drawing document on a scene.

REST: `GET /api/scenes/:sceneId/drawings`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_lights`

Lists every embedded AmbientLight document on a scene.

REST: `GET /api/scenes/:sceneId/lights`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_notes`

Lists every embedded Note document on a scene.

REST: `GET /api/scenes/:sceneId/notes`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_regions`

Lists every embedded Region document on a scene.

REST: `GET /api/scenes/:sceneId/regions`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_sounds`

Lists every embedded AmbientSound document on a scene.

REST: `GET /api/scenes/:sceneId/sounds`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_templates`

Lists every embedded MeasuredTemplate document on a scene.

REST: `GET /api/scenes/:sceneId/templates`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_tokens`

Lists a scene's embedded Token documents.

REST: `GET /api/scenes/:sceneId/tokens`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scene_walls`

Lists every embedded Wall document on a scene.

REST: `GET /api/scenes/:sceneId/walls`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |

### `foundry_list_scenes`

Lists every Scene document in the current world.

REST: `GET /api/scenes`

_No input._

### `foundry_move_scene_token`

Moves a token to new x/y canvas coordinates.

REST: `POST /api/scenes/:sceneId/tokens/:tokenId/move`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `tokenId` | string | yes |  |
| `x` | number | yes |  |
| `y` | number | yes |  |

### `foundry_reset_scene_fog`

Clears a scene's explored fog-of-war for every connected client.

REST: `POST /api/scenes/:id/reset-fog`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `foundry_set_scene_token_visibility`

Sets whether a token is hidden from non-GM players.

REST: `PUT /api/scenes/:sceneId/tokens/:tokenId/visibility`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `tokenId` | string | yes |  |
| `hidden` | boolean | yes |  |

### `foundry_update_scene`

Updates fields on an existing Scene document.

REST: `PUT /api/scenes/:id`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_drawing`

Updates fields on an existing embedded Drawing document on a scene.

REST: `PUT /api/scenes/:sceneId/drawings/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_light`

Updates fields on an existing embedded AmbientLight document on a scene.

REST: `PUT /api/scenes/:sceneId/lights/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_note`

Updates fields on an existing embedded Note document on a scene.

REST: `PUT /api/scenes/:sceneId/notes/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_region`

Updates fields on an existing embedded Region document on a scene.

REST: `PUT /api/scenes/:sceneId/regions/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_sound`

Updates fields on an existing embedded AmbientSound document on a scene.

REST: `PUT /api/scenes/:sceneId/sounds/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_template`

Updates fields on an existing embedded MeasuredTemplate document on a scene.

REST: `PUT /api/scenes/:sceneId/templates/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_token`

Updates fields on an existing embedded Token document on a scene.

REST: `PUT /api/scenes/:sceneId/tokens/:tokenId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `tokenId` | string | yes |  |
| `changes` | object | yes |  |

### `foundry_update_scene_wall`

Updates fields on an existing embedded Wall document on a scene.

REST: `PUT /api/scenes/:sceneId/walls/:placeableId`

| Field | Type | Required | Description |
|---|---|---|---|
| `sceneId` | string | yes |  |
| `placeableId` | string | yes |  |
| `changes` | object | yes |  |

## search

### `foundry_search`

Case-insensitive name-substring search across world document collections (game.collections). `types` optionally limits the search to a comma-separated list of document type names (e.g. "Actor,Item"); omit to search every collection.

REST: `GET /api/search`

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes |  |
| `types` | string | no |  |

## settings

### `foundry_get_setting`

Reads a single registered game setting by namespace and key.

REST: `GET /api/settings/:namespace/:key`

| Field | Type | Required | Description |
|---|---|---|---|
| `namespace` | string | yes |  |
| `key` | string | yes |  |

### `foundry_list_settings`

Every registered game setting (namespace, key, name, hint, scope, config, typeName).

REST: `GET /api/settings`

_No input._

### `foundry_set_setting`

Writes a single registered game setting by namespace and key. World-scope settings require the connected Foundry user to be a GM.

REST: `PUT /api/settings/:namespace/:key`

| Field | Type | Required | Description |
|---|---|---|---|
| `namespace` | string | yes |  |
| `key` | string | yes |  |
| `value` | any | yes |  |

## status

### `foundry_get_status`

Core Foundry world/system/user identifiers: Foundry version, world id, system id, and current user id.

REST: `GET /api/status`

_No input._

## system

### `foundry_get_system`

Details of the active game system (id, title, version).

REST: `GET /api/system`

_No input._

## user

### `foundry_get_user`

Details of the current Foundry user connected via the bridge (id, name, role, isGM, active).

REST: `GET /api/user`

_No input._

## users

### `foundry_create_user`

Creates a new User document. GM only.

REST: `POST /api/users`

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | object | yes |  |

### `foundry_delete_user`

Deletes a User document by id. GM only.

REST: `DELETE /api/users/:userId`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |

### `foundry_get_active_gm`

Looks up the world's currently active GM (game.users.activeGM) — one connected Gamemaster (non-assistant if possible), or null if none is connected. Useful for workflows that should happen once, on a single authoritative client, rather than once per connected GM. Registered ahead of GET /users/:userId so the literal 'active-gm' path segment isn't swallowed by that param route.

REST: `GET /api/users/active-gm`

_No input._

### `foundry_get_user_by_id`

Reads a single User document's full data by id.

REST: `GET /api/users/:userId`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |

### `foundry_get_user_role`

Reads a user's world permission level (CONST.USER_ROLES value).

REST: `GET /api/users/:userId/role`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |

### `foundry_get_user_status`

Reads whether a user currently has an active connection to the world.

REST: `GET /api/users/:userId/status`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |

### `foundry_list_users`

Every user in the world (id, name, role, isGM, active).

REST: `GET /api/users`

_No input._

### `foundry_set_user_role`

Sets a user's world permission level (CONST.USER_ROLES value). GM only.

REST: `PUT /api/users/:userId/role`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |
| `role` | integer | yes |  |

### `foundry_update_user`

Updates fields on an existing User document. GM only.

REST: `PUT /api/users/:userId`

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | yes |  |
| `changes` | object | yes |  |

## world

### `foundry_get_world`

Details of the currently active Foundry world (id, title, description, system, background).

REST: `GET /api/world`

_No input._

## world-time

### `foundry_advance_world_time`

Advances the world time by the given number of seconds (negative rewinds it). GM only.

REST: `POST /api/world-time/advance`

| Field | Type | Required | Description |
|---|---|---|---|
| `seconds` | number | yes |  |

### `foundry_get_world_time`

Reads the current world time (game.time.worldTime), in seconds.

REST: `GET /api/world-time`

_No input._

## Integration: dnd5e (system)

_These tools only appear when system `dnd5e` is active in the connected Foundry world — see PLAN.md's Phase 32._

### `dnd5e_adjust_spell_slot`

Spends or restores one dnd5e spell slot for an actor (negative delta spends, positive restores).

REST: `POST /api/integrations/dnd5e/actors/:id/spell-slots`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `level` | any | yes |  |
| `delta` | integer | yes |  |

### `dnd5e_get_actor_inventory`

An actor's items with dnd5e-specific fields: quantity, equipped, attuned, activities.

REST: `GET /api/integrations/dnd5e/actors/:id/inventory`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `dnd5e_get_actor_sheet`

Structured dnd5e actor sheet summary: abilities, saves, skills, AC, HP, senses, currency, spell slots, class/level, proficiency bonus.

REST: `GET /api/integrations/dnd5e/actors/:id/sheet`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `dnd5e_get_config`

Relevant slices of dnd5e's CONFIG.DND5E (abilities, skills, damage types, condition types) so a caller doesn't need hardcoded dnd5e knowledge to interpret raw actor data.

REST: `GET /api/integrations/dnd5e/config`

_No input._

### `dnd5e_rest`

Runs a short or long rest for an actor (HP/resource recovery).

REST: `POST /api/integrations/dnd5e/actors/:id/rest`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `type` | string | yes |  |

### `dnd5e_roll_ability_check`

Rolls a dnd5e ability check for an actor (e.g. a Strength check).

REST: `POST /api/integrations/dnd5e/actors/:id/roll/ability-check`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `ability` | string | yes |  |

### `dnd5e_roll_death_save`

Rolls a dnd5e death saving throw for an actor.

REST: `POST /api/integrations/dnd5e/actors/:id/roll/death-save`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

### `dnd5e_roll_saving_throw`

Rolls a dnd5e saving throw for an actor (e.g. a Dexterity save).

REST: `POST /api/integrations/dnd5e/actors/:id/roll/saving-throw`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `ability` | string | yes |  |

### `dnd5e_roll_skill`

Rolls a dnd5e skill check for an actor (e.g. Stealth).

REST: `POST /api/integrations/dnd5e/actors/:id/roll/skill`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |
| `skill` | string | yes |  |

### `dnd5e_use_item`

Triggers a dnd5e item's use (e.g. consuming a charge, activating an activity), searched across world items and every actor's embedded items.

REST: `POST /api/integrations/dnd5e/items/:id/use`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes |  |

## Integration: digital-tabletops (module)

_These tools only appear when module `digital-tabletops` is active in the connected Foundry world — see PLAN.md's Phase 32._

### `dtt_get_status`

Convenience composite read for the digital-tabletops integration: whether the module is active, whether a Foundry user named "TV" (case-insensitive, matching dtt.js's own check) exists and is currently online, and the module's four current world settings (namespace "digital-tabletops": hideUI, lockPan, display-width, port-number — also individually reachable via the generic GET/PUT /api/settings/digital-tabletops/:key endpoints). Call this before dtt_pan_battlemap/dtt_scale_battlemap_to_physical to confirm a display is actually connected.

REST: `GET /api/integrations/digital-tabletops/status`

_No input._

### `dtt_pan_battlemap`

Pans (and, when both targetWidth and targetHeight are given, scales to fit that region) the digital-tabletops battlemap display's view — the connected Foundry user literally named "TV". Advisory only: this broadcasts over Foundry's own multiplayer socket (module.digital-tabletops) and does not read back whether the TV client actually applied it, or whether a TV client is even connected — call dtt_get_status first to check.

REST: `POST /api/integrations/digital-tabletops/pan`

| Field | Type | Required | Description |
|---|---|---|---|
| `x` | number | yes |  |
| `y` | number | yes |  |
| `targetWidth` | number | no |  |
| `targetHeight` | number | no |  |

### `dtt_scale_battlemap_to_physical`

Scales the digital-tabletops battlemap display (the "TV" Foundry user) so 1 grid unit = 1 real-world inch/mm, per the module's configured display-width setting. Advisory only, same caveat as dtt_pan_battlemap — call dtt_get_status first to confirm a TV display is actually connected.

REST: `POST /api/integrations/digital-tabletops/scale-to-physical`

_No input._

