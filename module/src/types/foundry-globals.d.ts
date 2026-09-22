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
