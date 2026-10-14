import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { io, type Socket } from "socket.io-client";

export interface FoundrySessionIdentity {
  worldId: string;
  userId: string;
  userName: string;
  role: number;
  isGM: boolean;
}

export type FoundrySessionVerificationErrorCode =
  | "missing_cookie"
  | "malformed_cookie"
  | "unauthenticated"
  | "not_in_world"
  | "unavailable"
  | "timeout"
  | "redirect"
  | "malformed_response";

export type FoundrySessionVerificationResult =
  | { ok: true; identity: FoundrySessionIdentity }
  | { ok: false; code: FoundrySessionVerificationErrorCode };

export interface FoundrySessionVerifier {
  verify(request: IncomingMessage): Promise<FoundrySessionVerificationResult>;
}

interface SessionSignal {
  userId: string;
}

interface SessionExchange {
  session: unknown;
  joinData: unknown;
}

interface PinnedTarget {
  address: string;
  family: 4 | 6;
}

export interface FoundrySessionVerifierOptions {
  allowedFoundryOrigins: readonly string[];
  timeoutMs?: number;
  preflightImpl?: (
    origin: string,
    cookieHeader: string,
    timeoutMs: number,
    target: PinnedTarget,
  ) => Promise<number>;
  sessionExchange?: (
    origin: string,
    cookieHeader: string,
    timeoutMs: number,
    target: PinnedTarget,
  ) => Promise<SessionExchange>;
  lookupImpl?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}

/**
 * Verifies one browser session directly with a fixed, allowlisted loopback
 * Foundry v14 server. Cookie bytes are held only in this call and are never
 * included in results, errors, diagnostics, or instance state.
 */
export class LocalFoundrySessionVerifier implements FoundrySessionVerifier {
  private readonly origins: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly preflightImpl: NonNullable<FoundrySessionVerifierOptions["preflightImpl"]>;
  private readonly sessionExchange: NonNullable<FoundrySessionVerifierOptions["sessionExchange"]>;
  private readonly lookupImpl: NonNullable<FoundrySessionVerifierOptions["lookupImpl"]>;

  constructor(options: FoundrySessionVerifierOptions) {
    const origins = options.allowedFoundryOrigins.map(normalizeLoopbackFoundryOrigin);
    if (origins.length === 0 || origins.some((origin) => origin === null)) {
      throw new Error("Foundry session verification requires explicit loopback origins.");
    }
    this.origins = new Set(origins as string[]);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("Foundry session verification timeout is out of bounds.");
    }
    this.preflightImpl = options.preflightImpl ?? requestFoundryGame;
    this.sessionExchange = options.sessionExchange ?? exchangeFoundrySession;
    this.lookupImpl =
      options.lookupImpl ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  }

  async verify(request: IncomingMessage): Promise<FoundrySessionVerificationResult> {
    const origin = singleHeader(request.headers.origin);
    if (!origin || !this.origins.has(origin)) return { ok: false, code: "unavailable" };
    const cookie = extractSingleCookieHeader(request);
    if (!cookie.ok) return cookie;

    const startedAt = Date.now();
    const resolved = await this.resolvePinnedLoopback(origin, this.timeoutMs);
    if (!resolved.ok) return resolved;
    let remaining = this.timeoutMs - (Date.now() - startedAt);
    if (remaining < 1) return { ok: false, code: "timeout" };
    const preflight = await this.preflight(origin, cookie.value, remaining, resolved.target);
    if (!preflight.ok) return preflight;
    remaining = this.timeoutMs - (Date.now() - startedAt);
    if (remaining < 1) return { ok: false, code: "timeout" };

    let exchange: SessionExchange;
    try {
      exchange = await this.sessionExchange(origin, cookie.value, remaining, resolved.target);
    } catch (error) {
      return { ok: false, code: isTimeoutError(error) ? "timeout" : "unavailable" };
    }
    return validateSessionExchange(exchange);
  }

  private async resolvePinnedLoopback(
    origin: string,
    timeoutMs: number,
  ): Promise<{ ok: true; target: PinnedTarget } | { ok: false; code: "timeout" | "unavailable" }> {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    if (isLoopbackAddress(hostname)) {
      return { ok: true, target: { address: hostname, family: hostname.includes(":") ? 6 : 4 } };
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const addresses = await Promise.race([
        this.lookupImpl(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (
        addresses.length === 0 ||
        !addresses.every(
          ({ address, family }) => isLoopbackAddress(address) && (family === 4 || family === 6),
        )
      ) {
        return { ok: false, code: "unavailable" };
      }
      const selected = addresses[0];
      return selected
        ? {
            ok: true,
            target: { address: selected.address, family: selected.family as 4 | 6 },
          }
        : { ok: false, code: "unavailable" };
    } catch (error) {
      return { ok: false, code: isTimeoutError(error) ? "timeout" : "unavailable" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async preflight(
    origin: string,
    cookieHeader: string,
    timeoutMs: number,
    target: PinnedTarget,
  ): Promise<{ ok: true } | { ok: false; code: FoundrySessionVerificationErrorCode }> {
    try {
      const status = await this.preflightImpl(origin, cookieHeader, timeoutMs, target);
      if (status >= 300 && status < 400) return { ok: false, code: "redirect" };
      if (status === 401 || status === 403) return { ok: false, code: "unauthenticated" };
      if (status !== 200) return { ok: false, code: "unavailable" };
      return { ok: true };
    } catch (error) {
      return { ok: false, code: isTimeoutError(error) ? "timeout" : "unavailable" };
    }
  }
}

async function requestFoundryGame(
  origin: string,
  cookieHeader: string,
  timeoutMs: number,
  target: PinnedTarget,
): Promise<number> {
  const url = new URL("/game", origin);
  const agent = createPinnedAgent(url.protocol, target);
  return new Promise<number>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "GET",
        agent,
        headers: { Accept: "text/html", Cookie: cookieHeader },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        response.once("end", () => resolve(status));
      },
    );
    request.once("error", reject);
    request.end();
  }).finally(() => agent.destroy());
}

async function exchangeFoundrySession(
  origin: string,
  cookieHeader: string,
  timeoutMs: number,
  target: PinnedTarget,
): Promise<SessionExchange> {
  return new Promise<SessionExchange>((resolve, reject) => {
    let settled = false;
    let session: unknown;
    const url = new URL(origin);
    const agent = createPinnedAgent(url.protocol, target);
    const socket: Socket = io(origin, {
      path: "/socket.io",
      transports: ["websocket"],
      upgrade: false,
      reconnection: false,
      forceNew: true,
      timeout: timeoutMs,
      agent: agent as unknown as string,
      extraHeaders: { Cookie: cookieHeader },
    });
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    timer.unref?.();

    const finish = (error?: Error, joinData?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
      agent.destroy();
      if (error) reject(error);
      else resolve({ session, joinData });
    };

    socket.once("connect_error", () => finish(new Error("unavailable")));
    socket.once("session", (value: unknown) => {
      session = value;
      if (!parseSessionSignal(value)) {
        finish(undefined, null);
        return;
      }
      socket.emit("getJoinData", (joinData: unknown) => finish(undefined, joinData));
    });
  });
}

function createPinnedAgent(protocol: string, target: PinnedTarget): http.Agent | https.Agent {
  const options = {
    lookup: (
      _hostname: string,
      lookupOptions: LookupOptions,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      if (lookupOptions.all) {
        callback(null, [{ address: target.address, family: target.family }]);
      } else {
        callback(null, target.address, target.family);
      }
    },
  };
  return protocol === "https:" ? new https.Agent(options) : new http.Agent(options);
}

function validateSessionExchange(exchange: SessionExchange): FoundrySessionVerificationResult {
  const session = parseSessionSignal(exchange.session);
  if (!session) return { ok: false, code: "unauthenticated" };
  if (typeof exchange.joinData !== "object" || exchange.joinData === null) {
    return { ok: false, code: "malformed_response" };
  }
  const data = exchange.joinData as {
    userId?: unknown;
    world?: { id?: unknown };
    users?: unknown;
  };
  if (data.userId === null) return { ok: false, code: "not_in_world" };
  if (
    typeof data.userId !== "string" ||
    data.userId !== session.userId ||
    !isIdentifier(data.world?.id) ||
    !Array.isArray(data.users) ||
    data.users.length > 10_000
  ) {
    return { ok: false, code: "malformed_response" };
  }
  const matchingUsers = data.users.filter(
    (value): value is { _id: string; name: string; role: number } =>
      typeof value === "object" &&
      value !== null &&
      (value as { _id?: unknown })._id === session.userId &&
      typeof (value as { name?: unknown }).name === "string" &&
      (value as { name: string }).name.length > 0 &&
      (value as { name: string }).name.length <= 128 &&
      Number.isSafeInteger((value as { role?: unknown }).role),
  );
  if (matchingUsers.length !== 1) return { ok: false, code: "malformed_response" };
  const user = matchingUsers[0];
  if (!user || user.role < 0 || user.role > 4) return { ok: false, code: "malformed_response" };
  return {
    ok: true,
    identity: {
      worldId: data.world.id,
      userId: session.userId,
      userName: user.name,
      role: user.role,
      isGM: user.role === 4,
    },
  };
}

function parseSessionSignal(value: unknown): SessionSignal | null {
  if (typeof value !== "object" || value === null) return null;
  const signal = value as { sessionId?: unknown; userId?: unknown };
  return typeof signal.sessionId === "string" &&
    signal.sessionId.length > 0 &&
    isIdentifier(signal.userId)
    ? { userId: signal.userId }
    : null;
}

function extractSingleCookieHeader(
  request: IncomingMessage,
): { ok: true; value: string } | { ok: false; code: "missing_cookie" | "malformed_cookie" } {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "cookie") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return { ok: false, code: "missing_cookie" };
  if (values.length !== 1) return { ok: false, code: "malformed_cookie" };
  const value = values[0] ?? "";
  if (
    value.length < 1 ||
    value.length > 8_192 ||
    hasControlCharacter(value) ||
    !value.split(";").every((part) => {
      const pair = part.trim();
      if (!COOKIE_PAIR.test(pair)) return false;
      const pairValue = pair.slice(pair.indexOf("=") + 1);
      return [...pairValue].every(isCookieOctet);
    })
  ) {
    return { ok: false, code: "malformed_cookie" };
  }
  const sessionCookies = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf("=")) === "session");
  if (sessionCookies.length === 0) return { ok: false, code: "missing_cookie" };
  if (sessionCookies.length !== 1 || sessionCookies[0] === "session=") {
    return { ok: false, code: "malformed_cookie" };
  }
  const sessionCookie = sessionCookies[0] as string;
  return { ok: true, value: sessionCookie };
}

const COOKIE_PAIR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isCookieOctet(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x2b) ||
    (code >= 0x2d && code <= 0x3a) ||
    (code >= 0x3c && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  );
}

function normalizeLoopbackFoundryOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !isPotentialLoopbackHostname(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isPotentialLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) return isLoopbackAddress(hostname);
  return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
    hostname,
  );
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isTimeoutError(value: unknown): boolean {
  return (
    (value instanceof DOMException &&
      (value.name === "AbortError" || value.name === "TimeoutError")) ||
    (value instanceof Error && value.message === "timeout")
  );
}
