// Minimal ambient declarations for the Foundry VTT client globals this
// module actually calls. This is deliberately NOT a full Foundry API type
// surface — a later phase (6+, once real Foundry API calls start) can
// evaluate pulling in the community `@league-of-foundry-developers/foundry-vtt-types`
// package instead of hand-maintaining this file.

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
}

interface GameSettings {
  register<T>(
    namespace: string,
    key: string,
    data: ClientSettings.RegisterOptions<T>,
  ): void;
  get<T>(namespace: string, key: string): T;
}

declare const game: {
  settings: GameSettings;
};

declare const Hooks: {
  once(hook: string, callback: () => void): void;
  on(hook: string, callback: () => void): void;
};
