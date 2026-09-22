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
};

declare const Hooks: {
  once(hook: string, callback: () => void): void;
  on(hook: string, callback: () => void): void;
};
