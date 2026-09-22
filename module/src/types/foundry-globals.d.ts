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

/** Shape of `game.user` and each value in `game.users`. */
interface FoundryUser {
  id: string;
  name: string;
  role: number;
  isGM: boolean;
  active: boolean;
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
  create(data: Record<string, unknown>): Promise<FoundryDocument | undefined>;
}

/** A loaded Actor document — the `FoundryDocument` subset plus the actor-specific API Phase 9 drives. */
interface FoundryActor extends FoundryDocument {
  getRollData(): Record<string, unknown>;
  /** The actor's embedded Item documents. */
  items: Map<string, FoundryDocument>;
  /** Creates one or more embedded documents of the given type (e.g. "Item") on this actor. */
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
  collections: Map<string, Map<string, FoundryDocument>>;
};

/** Keyed by Foundry document type name (e.g. "JournalEntry"). */
declare const CONFIG: {
  [documentType: string]: { documentClass: FoundryDocumentClass } | undefined;
};

declare const Hooks: {
  once(hook: string, callback: () => void): void;
  on(hook: string, callback: () => void): void;
};
