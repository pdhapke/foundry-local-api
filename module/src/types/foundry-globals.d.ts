// Minimal ambient declarations for the Foundry VTT client globals this
// module actually calls. This is deliberately NOT a full Foundry API type
// surface — a later phase (6+, once real Foundry API calls start) can
// evaluate pulling in the community `@league-of-foundry-developers/foundry-vtt-types`
// package instead of hand-maintaining this file.
//
// Phase 6 extended this with just enough of `game.release`/`world`/`system`/
// `user`/`users`/`modules`/`settings.settings` to back the core
// meta/introspection command handlers (module/src/commands/meta.ts) — still
// hand-rolled, still deliberately minimal, not the community package (see
// PLAN.md's Phase 6 deviations note for why).
//
// Phase 7 added `GameSettings#set` to back the settings write command
// handler (module/src/commands/settings.ts).
//
// Phase 8 added `game.collections`/`CONFIG` plus the minimal `Document`/
// `DocumentClass` shapes to back the generic document CRUD command handlers
// (module/src/commands/documents.ts). `game.collections` and `CONFIG` are
// intentionally untyped past this — every Foundry document type's specific
// data schema stays out of scope for this generic layer.
//
// Phase 9 added `FoundryActor` (`getRollData()` and the embedded `items`
// collection) to back the actor-specific command handlers
// (module/src/commands/actors.ts). Actor CRUD itself uses the generic
// `FoundryDocument`/`FoundryDocumentClass` shapes above unchanged.
//
// Phase 10 added `FoundryActor#createEmbeddedDocuments()` to back embedded
// Item creation (module/src/commands/items.ts). Get/update/delete of a
// single embedded item need no new API surface — an embedded item is itself
// a `FoundryDocument` (Foundry routes `.update()`/`.delete()` on it through
// its parent actor automatically), so the existing `items` map plus
// `FoundryDocument`'s own methods are enough.
//
// Phase 11 added `FoundryScene` (`grid`/`dimensions`/`activate()`) to back
// the scene-specific command handlers (module/src/commands/scenes.ts). Scene
// CRUD itself uses the generic `FoundryDocument`/`FoundryDocumentClass`
// shapes above unchanged.
//
// Phase 12 added `FoundryScene#tokens`/`createEmbeddedDocuments()` to back
// the scene-embedded Token command handlers (module/src/commands/tokens.ts),
// the same shape Phase 9/10 already gave `FoundryActor` for its embedded
// Items.
//
// Phase 13 added `FoundryJournalEntry` (`pages`/`createEmbeddedDocuments()`)
// to back the embedded JournalEntryPage command handlers
// (module/src/commands/journal-pages.ts), the same shape already given to
// `FoundryActor`/`FoundryScene` for their own embedded collections.
// JournalEntry CRUD itself uses the generic `FoundryDocument`/
// `FoundryDocumentClass` shapes above unchanged.
//
// Phase 14 added the `Roll` class (module/src/commands/rolls.ts) — the first
// ambient declaration in this file that isn't a Document/collection shape.
// Chat messages needed no new declarations at all: `ChatMessage` is a
// regular document type, already covered by Phase 8's generic
// `game.collections`/`CONFIG` surface (module/src/commands/chat.ts).
//
// Phase 15 added `FoundryMacro` (`execute()`) to back the macro execution
// command handler (module/src/commands/macros.ts). Macro CRUD itself uses
// the generic `FoundryDocument`/`FoundryDocumentClass` shapes above
// unchanged.
//
// Phase 16 added `FoundryCombat` (turn/round control, embedded `combatants`,
// initiative rolling) to back the combat-specific command handlers
// (module/src/commands/combats.ts), following the same embedded-collection
// shape Phase 9/10 gave `FoundryActor` for Items and Phase 11/12 gave
// `FoundryScene` for Tokens. Combat CRUD itself uses the generic
// `FoundryDocument`/`FoundryDocumentClass` shapes above unchanged.
//
// Phase 17 added `FoundryPlaylist` (`playSound()`/`stopSound()`, embedded
// `sounds`) and `FoundryPlaylistSound` (`playing`/`pausedTime` plus the
// underlying `sound.currentTime` used to implement pause) to back the
// playlist-specific command handlers (module/src/commands/playlists.ts).
// Playlist CRUD itself uses the generic `FoundryDocument`/
// `FoundryDocumentClass` shapes above unchanged.
//
// Phase 18 added `FoundryRollTable` (`draw()`) to back the roll-table draw
// command handler (module/src/commands/roll-tables.ts) and
// `FoundryCardsStack` (`draw()`/`shuffle()`/`reset()`) to back the card-pile
// command handlers (module/src/commands/cards.ts). RollTable/Cards CRUD
// itself uses the generic `FoundryDocument`/`FoundryDocumentClass` shapes
// above unchanged. Named `FoundryCardsStack` rather than `FoundryCards` to
// avoid colliding with Foundry's own global `Cards` document class.
//
// Phase 20 added `game.packs` (`FoundryCompendiumCollection`, covering
// `metadata`/`index`/`getIndex()`/`getDocument()`/`documentClass`) to back
// the compendium-pack command handlers (module/src/commands/packs.ts), plus
// an `importFromCompendium()` method on the world-collection values of
// `game.collections` (renamed to `FoundryWorldCollection`, a `Map` subtype
// so every earlier phase's `game.collections.get(type)` call sites are
// unaffected) to back importing a pack entry into the world.
// `FoundryDocumentClass#create()` gained an optional `options` parameter so a
// pack entry can be created with `{pack: <packId>}`; every earlier call site
// that omits it is unaffected.
//
// Phase 21 added `effects: Map<string, FoundryDocument>` to `FoundryActor`
// and a new `FoundryItem` interface (the `FoundryDocument` subset plus its
// own `effects`/`createEmbeddedDocuments()`) to back the embedded
// ActiveEffect command handlers (module/src/commands/active-effects.ts) — an
// ActiveEffect can be embedded on either parent type, the first Phase to
// need the same embedded-collection shape on more than one document type.
//
// Phase 22 added `FoundryScene#getEmbeddedCollection()` — the first use of
// Foundry's generic embedded-collection accessor in this file — rather than
// naming each of the six placeable types' own collection properties
// (`drawings`/`notes`/`lights`/`sounds`/`walls`/`templates`), since the
// property name doesn't derive mechanically from the document type name the
// way `createEmbeddedDocuments()`'s first argument already didn't need to
// (Phase 10 onward). Also added the top-level `canvas` global
// (`animatePan()`) to back the camera pan/zoom command handler
// (module/src/commands/placeables.ts).
//
// Phase 23 added `FoundryUser#update()` — a User is itself a Document, so
// setting its `role` field (a user's world permission level) is the same
// generic `.update(changes)` every other document-specific interface already
// exposes. Document ownership needed no new ambient surface at all: it reads
// and writes the standard `ownership` field already covered by
// `FoundryDocument#toObject()`/`update()` (module/src/commands/
// permissions.ts, resolving generically off `game.collections` like Phase
// 19's folder-move).
//
// Phase 24 added the `FilePicker` static class (`browse()`/`upload()`/
// `createDirectory()`) to back the file/asset command handlers
// (module/src/commands/files.ts) — the second ambient declaration in this
// file (after Phase 14's `Roll`) that isn't a Document/collection shape.
//
// Phase 25 added `FoundryUser#toObject()`/`delete()` to back User CRUD
// (module/src/commands/users.ts) — a User is itself a Document, so no new
// static creator declaration was needed either: `CONFIG.User.documentClass`
// already exists via Phase 8's generic `CONFIG` surface, and Foundry's real
// `User` document class supports the same static `create()` as every other
// document type. Also added `FoundryPlaceable` (`id`/`document`) and
// `canvas.scene`/`canvas.tokens.controlled` to back the read-only canvas
// selection command handler — `canvas.tokens.controlled` is an array of
// Token placeable objects (not TokenDocuments), each carrying the actual
// TokenDocument at `.document`.
//
// Phase 27 added `game.i18n` (`localize()`/`format()`/`has()`) to back the
// localization command handler and the `TextEditor` static class
// (`enrichHTML()`) to back HTML enrichment — the third ambient declaration
// in this file that isn't a Document/collection shape (after Phase 14's
// `Roll` and Phase 24's `FilePicker`). In-world search needed no new ambient
// surface at all: it resolves entirely off the already-declared
// `game.collections`/`FoundryDocument` shapes from Phase 8.
//
// Phase 26 widened `Hooks.on`'s callback signature to accept Foundry's real
// hook-specific positional args (`(...args: unknown[]) => void`) and to
// return the numeric hook id Foundry's real API returns (used with
// `Hooks.off`, which this phase doesn't need — nothing here unregisters a
// hook, so `Hooks.off` itself wasn't added) — needed to back the hook-
// forwarding registration (module/src/hooks.ts). `Hooks.once`'s signature is
// unchanged: every existing caller (`init`/`ready`) uses it with a
// zero-arg callback and no phase has needed otherwise.
//
// Phase 28 added `createDocuments()`/`updateDocuments()`/`deleteDocuments()`
// static methods to `FoundryDocumentClass` to back the generic batch command
// handlers (module/src/commands/bulk.ts) — Foundry's own native bulk-CRUD
// API, the same class Phase 8's single `create()` already lives on. Using
// these instead of looping N individual `.create()`/`.update()`/`.delete()`
// calls is the actual point of Phase 28: one bridge round-trip and one
// Foundry hook cycle per batch, not N. The query command needed no new
// ambient surface at all: it resolves entirely off Phase 8's existing
// `game.collections`/`FoundryDocument#toObject()` shapes.
//
// Phase 34 added `system: Record<string, unknown>` to `FoundryActor`/
// `FoundryItem` — the first phase needing a document's *live, derived*
// system data at runtime (every earlier phase only ever needed
// `toObject()`'s pre-derived source data). Deliberately left as a generic,
// untyped escape hatch: the shape is entirely defined by whichever game
// system is active, so this file stays system-agnostic (no per-*system*
// schema, on top of its existing no-per-document-type-schema minimalism);
// dnd5e-specific field access happens via a narrow local cast in
// module/src/commands/dnd5e.ts, not here. The shared ambient `CONFIG`
// declaration below is deliberately left untouched for the same reason —
// see module/src/commands/dnd5e.ts's header comment for the narrow local
// cast it uses instead to reach `CONFIG.DND5E`.

declare namespace ClientSettings {
  interface RegisterOptions<T> {
    name?: string;
    hint?: string;
    scope: "client" | "world";
    config: boolean;
    type?: unknown;
    default?: T;
    onChange?: (value: T) => void;
  }

  /** Shape of an entry in `game.settings.settings`, keyed `"${namespace}.${key}"`. */
  interface RegisteredSetting {
    name?: string;
    hint?: string;
    scope: "client" | "world";
    config: boolean;
    type?: unknown;
  }
}

interface GameSettings {
  register<T>(namespace: string, key: string, data: ClientSettings.RegisterOptions<T>): void;
  get<T>(namespace: string, key: string): T;
  set<T>(namespace: string, key: string, value: T): Promise<T>;
  /** Every registered setting, keyed `"${namespace}.${key}"` (Foundry v10+). */
  settings: Map<string, ClientSettings.RegisteredSetting>;
}

/** Foundry's localization engine — the subset of its API Phase 27 drives. */
interface GameI18n {
  localize(key: string): string;
  format(key: string, data?: Record<string, unknown>): string;
  has(key: string): boolean;
}

/** Shape of `game.user` and each value in `game.users`. */
interface FoundryUser {
  id: string;
  name: string;
  role: number;
  isGM: boolean;
  active: boolean;
  toObject(): Record<string, unknown>;
  /** Updates this user document's fields (e.g. `{ role }`) — a User is itself a Document. */
  update(changes: Record<string, unknown>): Promise<FoundryUser>;
  delete(): Promise<FoundryUser>;
}

/** Shape of each value in `game.modules`. */
interface FoundryModule {
  id: string;
  title: string;
  active: boolean;
  version: string;
}

/** A loaded Foundry Document instance — the subset of its API this module drives generically. */
interface FoundryDocument {
  id: string;
  toObject(): Record<string, unknown>;
  update(changes: Record<string, unknown>): Promise<FoundryDocument>;
  delete(): Promise<FoundryDocument>;
}

/** A document type's class, as found at `CONFIG.<Type>.documentClass`. */
interface FoundryDocumentClass {
  /** `options.pack` creates the document inside that compendium pack instead of the world. */
  create(
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument | undefined>;
  /** Creates many documents of this type in one call — Foundry's native bulk-create API. */
  createDocuments(
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument[]>;
  /** Updates many documents of this type in one call — each entry must carry its target's `_id`. */
  updateDocuments(
    updates: (Record<string, unknown> & { _id: string })[],
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument[]>;
  /** Deletes many documents of this type by id in one call, returning the ids actually deleted. */
  deleteDocuments(ids: string[], options?: Record<string, unknown>): Promise<string[]>;
}

/** A loaded Actor document — the `FoundryDocument` subset plus the actor-specific API Phase 9 drives. */
interface FoundryActor extends FoundryDocument {
  getRollData(): Record<string, unknown>;
  /** The actor's embedded Item documents. */
  items: Map<string, FoundryDocument>;
  /** The actor's embedded ActiveEffect documents. */
  effects: Map<string, FoundryDocument>;
  /**
   * The actor's live, derived system data (e.g. dnd5e's ability
   * modifiers/AC/HP, computed at runtime) — as opposed to `toObject()`,
   * which returns pre-derived source data missing computed fields.
   * Intentionally untyped/generic: the shape is entirely defined by
   * whichever game system is active. System-specific field access happens
   * via a local cast at the call site (see module/src/commands/dnd5e.ts).
   */
  system: Record<string, unknown>;
  /** Creates one or more embedded documents of the given type (e.g. "Item", "ActiveEffect") on this actor. */
  createEmbeddedDocuments(
    embeddedName: string,
    data: Record<string, unknown>[],
  ): Promise<FoundryDocument[]>;
}

/** A loaded Item document — the `FoundryDocument` subset plus the embedded ActiveEffect API Phase 21 drives. */
interface FoundryItem extends FoundryDocument {
  /** The item's embedded ActiveEffect documents. */
  effects: Map<string, FoundryDocument>;
  /** The item's live, derived system data — see `FoundryActor#system` above for why this is generic. */
  system: Record<string, unknown>;
  /** Creates one or more embedded documents of the given type (e.g. "ActiveEffect") on this item. */
  createEmbeddedDocuments(
    embeddedName: string,
    data: Record<string, unknown>[],
  ): Promise<FoundryDocument[]>;
}

/** A loaded Scene document — the `FoundryDocument` subset plus the grid/dimension/activation API Phase 11 drives. */
interface FoundryScene extends FoundryDocument {
  width: number;
  height: number;
  padding: number;
  grid: {
    type: number;
    size: number;
    distance: number;
    units: string;
  };
  /** Computed pixel dimensions of the padded scene canvas. */
  dimensions: {
    sceneWidth: number;
    sceneHeight: number;
    sceneX: number;
    sceneY: number;
  };
  /** Makes this the world's active/viewed scene. */
  activate(): Promise<FoundryScene>;
  /** The scene's embedded Token documents. */
  tokens: Map<string, FoundryDocument>;
  /** Creates one or more embedded documents of the given type (e.g. "Token") on this scene. */
  createEmbeddedDocuments(
    embeddedName: string,
    data: Record<string, unknown>[],
  ): Promise<FoundryDocument[]>;
  /** Generic accessor for any of this scene's embedded collections (e.g. "Drawing", "Wall"). */
  getEmbeddedCollection(embeddedName: string): Map<string, FoundryDocument>;
}

/** A loaded JournalEntry document — the `FoundryDocument` subset plus the embedded-page API Phase 13 drives. */
interface FoundryJournalEntry extends FoundryDocument {
  /** The journal entry's embedded JournalEntryPage documents. */
  pages: Map<string, FoundryDocument>;
  /** Creates one or more embedded documents of the given type (e.g. "JournalEntryPage") on this journal entry. */
  createEmbeddedDocuments(
    embeddedName: string,
    data: Record<string, unknown>[],
  ): Promise<FoundryDocument[]>;
}

/** A loaded Macro document — the `FoundryDocument` subset plus the execution API Phase 15 drives. */
interface FoundryMacro extends FoundryDocument {
  /** Runs the macro's stored script/chat command, exactly as Foundry's own macro bar does. */
  execute(): Promise<unknown>;
}

/** A loaded Combat document — the `FoundryDocument` subset plus the turn/round/combatant/initiative API Phase 16 drives. */
interface FoundryCombat extends FoundryDocument {
  /** Starts the encounter (round 1, initial turn order). */
  startCombat(): Promise<FoundryCombat>;
  /** Advances to the next turn. */
  nextTurn(): Promise<FoundryCombat>;
  /** Advances to the next round. */
  nextRound(): Promise<FoundryCombat>;
  /** Ends the encounter. */
  endCombat(): Promise<FoundryCombat>;
  /** Rolls initiative for the given combatant ids. */
  rollInitiative(ids: string[]): Promise<FoundryCombat>;
  /** Rolls initiative for every combatant currently missing it. */
  rollAll(): Promise<FoundryCombat>;
  /** The combat's embedded Combatant documents. */
  combatants: Map<string, FoundryDocument>;
  /** Creates one or more embedded documents of the given type (e.g. "Combatant") on this combat. */
  createEmbeddedDocuments(
    embeddedName: string,
    data: Record<string, unknown>[],
  ): Promise<FoundryDocument[]>;
}

/** A loaded PlaylistSound document — the `FoundryDocument` subset plus the playback state Phase 17 drives. */
interface FoundryPlaylistSound extends FoundryDocument {
  playing: boolean;
  pausedTime: number | null;
  /** The underlying Web Audio helper backing playback, present once the sound has been loaded. */
  sound?: { currentTime: number } | null;
}

/** A loaded Playlist document — the `FoundryDocument` subset plus the play/stop API Phase 17 drives. */
interface FoundryPlaylist extends FoundryDocument {
  /** Starts playback of one embedded sound, managing which others keep playing. */
  playSound(sound: FoundryPlaylistSound): Promise<FoundryPlaylist>;
  /** Stops playback of one embedded sound. */
  stopSound(sound: FoundryPlaylistSound): Promise<FoundryPlaylist>;
  /** The playlist's embedded PlaylistSound documents. */
  sounds: Map<string, FoundryPlaylistSound>;
}

/** A loaded RollTable document — the `FoundryDocument` subset plus the draw API Phase 18 drives. */
interface FoundryRollTable extends FoundryDocument {
  /** Evaluates the table's roll formula and draws the matching TableResult(s). */
  draw(options?: { displayChat?: boolean }): Promise<{ roll: Roll; results: FoundryDocument[] }>;
}

/** A loaded Cards stack document — the `FoundryDocument` subset plus the pile API Phase 18 drives. */
interface FoundryCardsStack extends FoundryDocument {
  /** Draws `number` cards from `source` into this stack, returning the drawn Card documents. */
  draw(source: FoundryCardsStack, number?: number): Promise<FoundryDocument[]>;
  /** Shuffles this stack's cards in place. */
  shuffle(): Promise<FoundryCardsStack>;
  /** Recalls every card dealt out of this stack back into it. */
  reset(): Promise<FoundryCardsStack>;
}

/** A world-level document collection, as found at `game.collections.get(<type>)` (e.g. `game.actors`). */
interface FoundryWorldCollection extends Map<string, FoundryDocument> {
  /** Loads the given compendium entry and creates a new document from it in this world collection. */
  importFromCompendium(
    pack: FoundryCompendiumCollection,
    id: string,
    updateData?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<FoundryDocument>;
}

/** A single compendium pack's metadata, as found at `CompendiumCollection#metadata`. */
interface FoundryCompendiumMetadata {
  /** The pack's own id, e.g. "world.my-macros" or "dnd5e.monsters". */
  id: string;
  label: string;
  /** The Foundry document type this pack stores, e.g. "Actor", "Item", "JournalEntry". */
  type: string;
  package: string;
  packageType: string;
  system?: string;
  path: string;
}

/** A loaded compendium pack — the subset of `CompendiumCollection`'s API Phase 20 drives. */
interface FoundryCompendiumCollection {
  metadata: FoundryCompendiumMetadata;
  /** The pack's currently-loaded index (may be empty until `getIndex()` is called). */
  index: Map<string, Record<string, unknown> & { _id: string; name: string }>;
  /** (Re)loads and returns the pack's index of lightweight entry summaries. */
  getIndex(options?: {
    fields?: string[];
  }): Promise<Map<string, Record<string, unknown> & { _id: string; name: string }>>;
  /** Loads a single full document from this pack by id. */
  getDocument(id: string): Promise<FoundryDocument | null>;
  /** The Document class backing this pack's entries, used to create a new entry directly in the pack. */
  documentClass: FoundryDocumentClass;
}

/** One die term's individual roll results within an evaluated `Roll` (e.g. a `2d6` roll's two dice). */
interface FoundryDieTerm {
  faces: number;
  results: Array<{ result: number; active: boolean }>;
}

/** Foundry's dice-rolling engine — the subset of its API Phase 14 drives. */
declare class Roll {
  constructor(formula: string, data?: Record<string, unknown>);
  formula: string;
  total: number;
  /** The resolved expression with each die replaced by its rolled value, e.g. "(4 + 2)". */
  result: string;
  dice: FoundryDieTerm[];
  evaluate(): Promise<Roll>;
}

declare const game: {
  settings: GameSettings;
  i18n: GameI18n;
  release: {
    version: string;
  };
  world: {
    id: string;
    title: string;
    description?: string;
    system: string;
    background?: string;
  };
  system: {
    id: string;
    title: string;
    version: string;
  };
  user: FoundryUser;
  users: Map<string, FoundryUser>;
  modules: Map<string, FoundryModule>;
  /** Keyed by Foundry document type name (e.g. "JournalEntry"), each a Map of that type's documents keyed by id. */
  collections: Map<string, FoundryWorldCollection>;
  /** Every compendium pack available in the world, keyed by pack id (e.g. "world.my-macros", "dnd5e.monsters"). */
  packs: Map<string, FoundryCompendiumCollection>;
};

/** Keyed by Foundry document type name (e.g. "JournalEntry"). */
declare const CONFIG: {
  [documentType: string]: { documentClass: FoundryDocumentClass } | undefined;
};

declare const Hooks: {
  once(hook: string, callback: () => void): void;
  /** Returns the numeric hook id Foundry's real `Hooks.on` returns (usable with `Hooks.off`). */
  on(hook: string, callback: (...args: unknown[]) => void): number;
};

/** Foundry's file/directory browser and uploader — the subset of its API Phase 24 drives. */
declare class FilePicker {
  /** Lists the directories/files under `target` on the given storage `source` (e.g. "data", "public", "s3"). */
  static browse(
    source: string,
    target: string,
    options?: Record<string, unknown>,
  ): Promise<{ target: string; source: string; dirs: string[]; files: string[] }>;
  /** Uploads `file` into `path` on the given storage `source`, subject to Foundry's own upload security model. */
  static upload(
    source: string,
    path: string,
    file: File,
    options?: Record<string, unknown>,
  ): Promise<{ path: string } | false>;
  /** Creates a new directory at `target` on the given storage `source`. */
  static createDirectory(
    source: string,
    target: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

/** Foundry's HTML enrichment engine — the subset of its static API Phase 27 drives. */
declare class TextEditor {
  /** Resolves content links (@UUID/@Actor/...), inline rolls, etc. in `content` into real HTML. */
  static enrichHTML(content: string, options?: Record<string, unknown>): Promise<string>;
}

/** A rendered canvas object (e.g. a Token) — distinct from its underlying Document, found at `.document`. */
interface FoundryPlaceable {
  id: string;
  document: FoundryDocument;
}

/** The currently-rendered game canvas, `null` before a scene has been activated/viewed. */
declare const canvas:
  | {
      stage: { pivot: { x: number; y: number } };
      /** Current zoom factor. */
      scale: number;
      /** Pans/zooms the view; omitted fields keep their current value. */
      animatePan(view: {
        x?: number | undefined;
        y?: number | undefined;
        scale?: number | undefined;
      }): Promise<void>;
      /** The Scene document currently being viewed. */
      scene: FoundryDocument | null;
      /** The token layer, whose `controlled` array holds the currently-selected Token placeables. */
      tokens: { controlled: FoundryPlaceable[] };
    }
  | null
  | undefined;
