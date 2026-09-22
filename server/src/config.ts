// Typed, validated runtime configuration for the server process.
//
// Env loading: we use the `dotenv` package (rather than Node's built-in
// `--env-file` flag) so `.env` loading isn't tied to how the process is
// launched (bare `node dist/index.js`, a process manager, a future test
// runner, etc.) — `--env-file` requires the flag to be present on every
// invocation, which is easy to forget outside of a hand-written npm script.
// `dotenv.config()` never overrides variables already present in the real
// environment, so real env vars (e.g. set by a process manager or CI) always
// win over `.env` file contents.
import { config as loadDotenv } from "dotenv";

loadDotenv();

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const DEFAULT_PORT = 3939;
const DEFAULT_HOST = "127.0.0.1";

export type NodeEnv = "development" | "production" | "test";

export interface AppConfig {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Address the HTTP server binds to. */
  host: string;
  /** `NODE_ENV`, defaulted to "development". */
  nodeEnv: NodeEnv;
  /** Whether the process is running with `NODE_ENV=development`. */
  isDevelopment: boolean;
  /** Milliseconds to wait for in-flight requests to finish on shutdown. */
  shutdownTimeoutMs: number;
  /** Default milliseconds `FoundryClient.call` waits for a bridge response before rejecting with a timeout error. */
  bridgeTimeoutMs: number;
}

/** Thrown when the environment describes an invalid or unsafe configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(
      `Invalid PORT "${raw}": must be an integer between 1 and 65535.`,
    );
  }
  return parsed;
}

function parseHost(raw: string | undefined): string {
  const host = raw === undefined || raw.trim() === "" ? DEFAULT_HOST : raw.trim();
  const allowRemoteBind = parseBoolean(process.env["ALLOW_REMOTE_BIND"]);

  if (!LOOPBACK_HOSTS.has(host) && !allowRemoteBind) {
    throw new ConfigError(
      `Refusing to bind to non-loopback HOST "${host}" without ` +
        `ALLOW_REMOTE_BIND=true. This server has no authentication yet ` +
        `(added in Phase 4) and full remote control of a running Foundry ` +
        `game is dangerous to expose beyond localhost. Set HOST to ` +
        `127.0.0.1 (default) or localhost, or explicitly opt in with ` +
        `ALLOW_REMOTE_BIND=true if you understand the risk.`,
    );
  }

  if (!LOOPBACK_HOSTS.has(host) && allowRemoteBind) {
    console.warn(
      "\n" +
        "!!! WARNING: ALLOW_REMOTE_BIND=true — binding to " +
        `"${host}" instead of localhost. !!!\n` +
        "This exposes full remote control of the connected Foundry game to " +
        "anything that can reach this address. Only do this on a trusted " +
        "network, and know that API-key auth does not land until Phase 4.\n",
    );
  }

  return host;
}

function parseBoolean(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === "production" || raw === "test" || raw === "development") {
    return raw;
  }
  if (raw === undefined || raw.trim() === "") {
    return "development";
  }
  throw new ConfigError(
    `Invalid NODE_ENV "${raw}": must be one of "development", "production", "test".`,
  );
}

function parseShutdownTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 10_000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Invalid SHUTDOWN_TIMEOUT_MS "${raw}": must be a positive integer.`,
    );
  }
  return parsed;
}

function parseBridgeTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 10_000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid BRIDGE_TIMEOUT_MS "${raw}": must be a positive integer.`);
  }
  return parsed;
}

/**
 * Loads and validates configuration from the environment. Throws
 * {@link ConfigError} on anything invalid or unsafe rather than silently
 * falling back to a default that could be dangerous (e.g. binding remotely).
 */
export function loadConfig(): AppConfig {
  const nodeEnv = parseNodeEnv(process.env["NODE_ENV"]);
  return {
    port: parsePort(process.env["PORT"]),
    host: parseHost(process.env["HOST"]),
    nodeEnv,
    isDevelopment: nodeEnv === "development",
    shutdownTimeoutMs: parseShutdownTimeout(process.env["SHUTDOWN_TIMEOUT_MS"]),
    bridgeTimeoutMs: parseBridgeTimeout(process.env["BRIDGE_TIMEOUT_MS"]),
  };
}
