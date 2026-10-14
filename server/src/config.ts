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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { readManagedCredential } from "../../scripts/foundry-managed-credential.mjs";
import { timingSafeEqualStrings } from "./security/api-key.js";
import { isValidAllowedHostPattern } from "./security/remote-access.js";

// Resolve `.env` explicitly relative to this module's own location rather
// than `process.cwd()`. `dotenv`'s default path resolution is
// cwd-relative, which is fragile — it differs depending on whether the
// process is launched via `npm run` inside the `server` workspace or as
// `node server/dist/index.js` from the repo root. We also need this exact
// path below to *write* the auto-provisioned API key back into the same
// file `dotenv` reads, so both operations share one resolved path. This
// file lives at `server/dist/config.js` once built, so `server/.env` is
// one directory up from this module.
const ENV_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

loadDotenv({ path: ENV_FILE_PATH });

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const DEFAULT_PORT = 3939;
const DEFAULT_HOST = "127.0.0.1";
const MIN_API_KEY_LENGTH = 16;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 100;
const DEFAULT_PUBLIC_MCP_PORT = 3940;
const DEFAULT_REMOTE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_REMOTE_RATE_LIMIT_MAX = 120;

export type NodeEnv = "development" | "production" | "test";

/**
 * Set only when `MCP_REMOTE_API_KEY` is configured. The public listener binds
 * to 127.0.0.1 on `port` and accepts this key on `/mcp` alone.
 */
export interface McpRemoteConfig {
  apiKey: string;
  port: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

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
  /**
   * Static administrative API key required on every `/api/*` and local `/mcp`
   * request. It is deliberately separate from Foundry-session authentication
   * for the GM `/bridge` lane, and it is not accepted on the public MCP
   * listener. Auto-provisioned on first startup if unset.
   */
  apiKey: string;
  /** Origins allowed to make cross-origin requests to `/api/*`. Empty = deny all cross-origin requests. */
  corsAllowedOrigins: string[];
  /** Rate-limit window (milliseconds) applied to `/api/*`. */
  rateLimitWindowMs: number;
  /** Max requests per `rateLimitWindowMs` per client, applied to `/api/*`. */
  rateLimitMax: number;
  /**
   * Whether to also start an MCP server on the process's own stdio (Phase 5),
   * for MCP clients like Claude Desktop/Code that spawn this process
   * directly rather than talking HTTP. When true, stdout is reserved
   * exclusively for the MCP JSON-RPC stream — see `server/src/index.ts` for
   * how the startup banner and request logger are redirected to stderr to
   * respect that.
   */
  mcpStdio: boolean;
  /**
   * Remote MCP listener settings, or `null` when `MCP_REMOTE_API_KEY` is unset
   * (the public port is not opened).
   */
  mcpRemote: McpRemoteConfig | null;
  /**
   * Host patterns permitted on the public MCP listener. Empty leaves that
   * check off. Non-empty also turns on loopback Host enforcement on the main
   * listener, as does enabling `mcpRemote`.
   */
  mcpAllowedHosts: readonly string[];
  /** When true, the main listener rejects non-loopback `Host` values. */
  enforceLoopbackHost: boolean;
  /** `0` means no cap. Applies independently to each MCP listener. */
  mcpMaxSessions: number;
  /** `0` means sessions do not expire for idleness. */
  mcpSessionIdleMs: number;
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
    throw new ConfigError(`Invalid PORT "${raw}": must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function parseHost(raw: string | undefined): string {
  const host = raw === undefined || raw.trim() === "" ? DEFAULT_HOST : raw.trim();
  const allowRemoteBind = parseBoolean(process.env["ALLOW_REMOTE_BIND"]);

  if (!LOOPBACK_HOSTS.has(host) && !allowRemoteBind) {
    throw new ConfigError(
      `Refusing to bind to non-loopback HOST "${host}" without ` +
        `ALLOW_REMOTE_BIND=true. Even with API-key auth in place, full ` +
        `remote control of a running Foundry game is dangerous to expose ` +
        `beyond localhost. Set HOST to 127.0.0.1 (default) or localhost, ` +
        `or explicitly opt in with ALLOW_REMOTE_BIND=true if you ` +
        `understand the risk.`,
    );
  }

  if (!LOOPBACK_HOSTS.has(host) && allowRemoteBind) {
    console.warn(
      "\n" +
        "!!! WARNING: ALLOW_REMOTE_BIND=true — binding to " +
        `"${host}" instead of localhost. !!!\n` +
        "This exposes REST/MCP access beyond loopback. The GM bridge lane " +
        "still refuses non-loopback binding. Only do this on a trusted network.\n",
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
    throw new ConfigError(`Invalid SHUTDOWN_TIMEOUT_MS "${raw}": must be a positive integer.`);
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
 * By the time this runs, `ensureApiKeyProvisioned` has already guaranteed
 * `process.env["API_KEY"]` is non-empty (auto-generating and persisting one
 * to `.env` on first startup if it wasn't set — see that function). So an
 * empty value here shouldn't normally happen; it's kept as a defensive
 * check. A value that *is* present but shorter than `MIN_API_KEY_LENGTH`
 * still throws — that's a deliberate user-supplied weak value, not the
 * "nothing was ever set" case, so we don't silently replace it.
 */
function parseApiKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (key === "") {
    throw new ConfigError(
      "API_KEY is not set and auto-provisioning did not populate it. Set " +
        "API_KEY in your .env file — generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new ConfigError(
      `API_KEY is too short (${key.length} chars, minimum ${MIN_API_KEY_LENGTH}). ` +
        "Generate a proper random key with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return key;
}

/**
 * Auto-provisions `API_KEY` on first startup. If `process.env["API_KEY"]`
 * is already set to a non-empty value (whether from a real env var or
 * already loaded from `.env` by `loadDotenv` above), this does nothing —
 * including when it's set but too short, which `parseApiKey` will reject
 * on its own; that's a deliberate user-supplied value, not the "nothing
 * was ever set" case, so we don't auto-heal it.
 *
 * Otherwise, generates a random 64-char hex key, persists it to the
 * resolved `.env` file (creating the file if it doesn't exist yet, or
 * inserting/updating just the `API_KEY=` line — leaving every other line
 * untouched — if it does), and sets `process.env["API_KEY"]` so the rest
 * of `loadConfig()` picks it up like any normally-configured value. Runs
 * synchronously at startup, before `loadConfig()` returns: this is a rare,
 * one-time disk write, not a hot path, so plain sync `fs` calls are fine.
 */
function ensureApiKeyProvisioned(): void {
  const existing = process.env["API_KEY"];
  if (existing !== undefined && existing.trim() !== "") {
    return;
  }

  const generated = randomBytes(32).toString("hex");
  const apiKeyLinePattern = /^API_KEY=.*$/m;

  if (!existsSync(ENV_FILE_PATH)) {
    writeFileSync(ENV_FILE_PATH, `API_KEY=${generated}\n`, "utf8");
  } else {
    const contents = readFileSync(ENV_FILE_PATH, "utf8");
    const updated = apiKeyLinePattern.test(contents)
      ? contents.replace(apiKeyLinePattern, `API_KEY=${generated}`)
      : contents +
        (contents.length > 0 && !contents.endsWith("\n") ? "\n" : "") +
        `API_KEY=${generated}\n`;
    writeFileSync(ENV_FILE_PATH, updated, "utf8");
  }

  process.env["API_KEY"] = generated;
  // MCP_STDIO reserves stdout for the MCP JSON-RPC stream from the moment
  // the process starts, so this one-time notice must not use console.log
  // when it's set — same constraint as the request logger/banner in
  // index.ts, just reached earlier (loadConfig() runs before those exist).
  const logSink = parseBoolean(process.env["MCP_STDIO"]) ? console.error : console.log;
  logSink(
    "No API_KEY found — generated a new one and saved it to .env. " +
      "See server/.env if you need it (e.g. to configure the Foundry module's API key setting).",
  );
}

function parseCorsAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseRateLimitWindowMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RATE_LIMIT_WINDOW_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid RATE_LIMIT_WINDOW_MS "${raw}": must be a positive integer.`);
  }
  return parsed;
}

function parseRateLimitMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RATE_LIMIT_MAX;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid RATE_LIMIT_MAX "${raw}": must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid ${name} "${raw}": must be a positive integer.`);
  }
  return parsed;
}

function parseRemoteRateLimitWindowMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REMOTE_RATE_LIMIT_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Invalid MCP_REMOTE_RATE_LIMIT_WINDOW_MS "${raw}": must be a positive integer.`,
    );
  }
  return parsed;
}

function parseRemoteRateLimitMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REMOTE_RATE_LIMIT_MAX;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Invalid MCP_REMOTE_RATE_LIMIT_MAX "${raw}": must be a positive integer.`,
    );
  }
  return parsed;
}

/**
 * Opt-in remote credential. Unset disables the public listener. A value that
 * matches `API_KEY` is rejected so the administrative key cannot be reused as
 * the credential a cloud client stores.
 */
function parseRemoteApiKey(raw: string | undefined, adminKey: string): string | null {
  const key = raw?.trim() ?? "";
  if (key === "") return null;
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new ConfigError(
      `MCP_REMOTE_API_KEY is too short (${key.length} chars, minimum ${MIN_API_KEY_LENGTH}). ` +
        "Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (timingSafeEqualStrings(key, adminKey)) {
    throw new ConfigError(
      "MCP_REMOTE_API_KEY must be different from API_KEY. The administrative key stays on this machine; the remote key is the only credential a tunnel client should hold.",
    );
  }
  return key;
}

function parsePublicMcpPort(raw: string | undefined, mainPort: number, enabled: boolean): number {
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ConfigError(
        `Invalid MCP_PUBLIC_PORT "${raw}": must be an integer between 1 and 65535.`,
      );
    }
    if (enabled && parsed === mainPort) {
      throw new ConfigError(
        `MCP_PUBLIC_PORT (${parsed}) must be different from PORT so the tunnel cannot reach the main listener.`,
      );
    }
    return parsed;
  }
  if (!enabled) return 0;
  if (mainPort === DEFAULT_PUBLIC_MCP_PORT) {
    throw new ConfigError(
      `PORT is ${DEFAULT_PUBLIC_MCP_PORT}, which is the default public MCP port. Set MCP_PUBLIC_PORT to a different port.`,
    );
  }
  return DEFAULT_PUBLIC_MCP_PORT;
}

function parseMcpAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const hosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  for (const host of hosts) {
    if (!isValidAllowedHostPattern(host)) {
      throw new ConfigError(
        `Invalid MCP_ALLOWED_HOSTS entry "${host}". Use a hostname, an IP, or a single-label wildcard such as *.trycloudflare.com.`,
      );
    }
  }
  return hosts;
}

/**
 * Loads and validates configuration from the environment. Throws
 * {@link ConfigError} on anything invalid or unsafe rather than silently
 * falling back to a default that could be dangerous (e.g. binding remotely).
 */
export function loadConfig(): AppConfig {
  const managed = readManagedCredential();
  if (!managed) ensureApiKeyProvisioned();
  const nodeEnv = parseNodeEnv(process.env["NODE_ENV"]);
  const port = parsePort(process.env["PORT"]);
  const apiKey = parseApiKey(managed?.key ?? process.env["API_KEY"]);
  const remoteApiKey = parseRemoteApiKey(process.env["MCP_REMOTE_API_KEY"], apiKey);
  const mcpAllowedHosts = parseMcpAllowedHosts(process.env["MCP_ALLOWED_HOSTS"]);
  const remoteRateLimitWindowMs = parseRemoteRateLimitWindowMs(
    process.env["MCP_REMOTE_RATE_LIMIT_WINDOW_MS"],
  );
  const remoteRateLimitMax = parseRemoteRateLimitMax(process.env["MCP_REMOTE_RATE_LIMIT_MAX"]);
  const mcpRemote =
    remoteApiKey === null
      ? null
      : {
          apiKey: remoteApiKey,
          port: parsePublicMcpPort(process.env["MCP_PUBLIC_PORT"], port, true),
          rateLimitWindowMs: remoteRateLimitWindowMs,
          rateLimitMax: remoteRateLimitMax,
        };
  if (remoteApiKey === null && process.env["MCP_PUBLIC_PORT"]?.trim()) {
    // Validate a stray port even when the listener stays off, so a typo is
    // not silent until the key is added later.
    parsePublicMcpPort(process.env["MCP_PUBLIC_PORT"], port, false);
  }
  return {
    port,
    host: parseHost(process.env["HOST"]),
    nodeEnv,
    isDevelopment: nodeEnv === "development",
    shutdownTimeoutMs: parseShutdownTimeout(process.env["SHUTDOWN_TIMEOUT_MS"]),
    bridgeTimeoutMs: parseBridgeTimeout(process.env["BRIDGE_TIMEOUT_MS"]),
    apiKey,
    corsAllowedOrigins: parseCorsAllowedOrigins(process.env["CORS_ALLOWED_ORIGINS"]),
    rateLimitWindowMs: parseRateLimitWindowMs(process.env["RATE_LIMIT_WINDOW_MS"]),
    rateLimitMax: parseRateLimitMax(process.env["RATE_LIMIT_MAX"]),
    mcpStdio: parseBoolean(process.env["MCP_STDIO"]),
    mcpRemote,
    mcpAllowedHosts,
    enforceLoopbackHost: mcpRemote !== null || mcpAllowedHosts.length > 0,
    mcpMaxSessions: parseOptionalPositiveInt(process.env["MCP_MAX_SESSIONS"], "MCP_MAX_SESSIONS"),
    mcpSessionIdleMs: parseOptionalPositiveInt(
      process.env["MCP_SESSION_IDLE_MS"],
      "MCP_SESSION_IDLE_MS",
    ),
  };
}
