// Identifies requests that arrived through an HTTP tunnel or reverse proxy,
// and derives a rate-limit key from those headers without enabling Express
// `trust proxy` (which would make `req.ip` client-controlled on every route).
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * Headers set by ngrok, cloudflared, and other reverse proxies. A direct
 * local client (curl, the Foundry module, a same-machine MCP client) does
 * not send them. Their presence on the main listener is treated as proof
 * the request was forwarded, and that listener then rejects every path.
 */
const PROXY_HEADER_NAMES = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "true-client-ip",
  "x-real-ip",
] as const;

function headerHasValue(value: string | string[] | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => entry.trim().length > 0);
  return false;
}

export function requestHasProxyHeaders(headers: IncomingHttpHeaders): boolean {
  for (const name of PROXY_HEADER_NAMES) {
    if (headerHasValue(headers[name])) return true;
  }
  return false;
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value.join(",");
  return undefined;
}

/** Accepts a bare IP, an IPv4 `ip:port`, or a bracketed IPv6 `[ip]:port`. */
export function parseIpToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  let value = token.trim().replace(/^"|"$/g, "");
  if (value.length === 0) return undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end <= 1) return undefined;
    value = value.slice(1, end);
  } else if (value.includes(".") && value.includes(":")) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  return isIP(value) ? value : undefined;
}

/**
 * Rate-limit identity for a request that reached the public MCP listener.
 *
 * The rightmost `X-Forwarded-For` entry is the address appended by the
 * nearest proxy (Cloudflare appends the visitor; ngrok sets the connecting
 * client). A client-supplied prefix cannot choose a fresh bucket. A
 * client-supplied `CF-Connecting-IP` is ignored when `X-Forwarded-For` is
 * present, because ngrok forwards that header without overwriting it.
 * With no usable forwarded address (a raw TCP tunnel) every request shares
 * the socket peer, which is still one finite bucket.
 */
export function remoteRateLimitKey(req: Request): string {
  const forwarded = headerText(req.headers["x-forwarded-for"]);
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const ip = parseIpToken(parts[index]);
      if (ip) return `xff:${ipKeyGenerator(ip)}`;
    }
  }

  const cloudflare = parseIpToken(headerText(req.headers["cf-connecting-ip"]));
  if (cloudflare) return `cf:${ipKeyGenerator(cloudflare)}`;

  const peer = req.socket.remoteAddress;
  if (peer && isIP(peer)) return `socket:${ipKeyGenerator(peer)}`;
  return "socket:unknown";
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Hostname from a `Host` or `X-Forwarded-Host` value, without the port.
 * Returns undefined for malformed values rather than guessing.
 */
export function hostnameFromHostHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > 512 ||
    trimmed.includes("/") ||
    trimmed.includes(" ") ||
    trimmed.includes("@") ||
    trimmed.includes("\\")
  ) {
    return undefined;
  }

  let host = trimmed;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end <= 1) return undefined;
    const rest = host.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return undefined;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && host.indexOf(":") === colon && /^\d{1,5}$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }

  if (host.length === 0 || host.length > 253) return undefined;
  return host;
}

/** Loopback names the Foundry bridge is allowed to use, including `*.localhost`. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    (hostname.endsWith(".localhost") && hostname !== ".localhost")
  );
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    const prefixLength = hostname.length - suffix.length - 1;
    if (prefixLength < 1 || hostname.slice(prefixLength) !== `.${suffix}`) return false;
    return HOSTNAME_LABEL.test(hostname.slice(0, prefixLength));
  }
  return hostname === pattern;
}

export function hostHeaderAllowed(value: string | undefined, patterns: readonly string[]): boolean {
  const hostname = hostnameFromHostHeader(value);
  if (!hostname) return false;
  return patterns.some((pattern) => matchesHostPattern(hostname, pattern));
}

/** Every value in a possibly comma-joined forwarded-host list must match. */
export function forwardedHostAllowed(
  value: string | string[] | undefined,
  patterns: readonly string[],
): boolean {
  if (value === undefined) return true;
  const text = headerText(value);
  if (text === undefined || text.trim().length === 0) return true;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .every((part) => hostHeaderAllowed(part, patterns));
}

const WILDCARD_SUFFIX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Validates one `MCP_ALLOWED_HOSTS` entry: a hostname, an IP, or a single-label
 * wildcard such as `*.trycloudflare.com`.
 */
export function isValidAllowedHostPattern(pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return WILDCARD_SUFFIX.test(pattern.slice(2));
  }
  if (isIP(pattern)) return true;
  if (pattern.length === 0 || pattern.length > 253 || pattern.includes("*")) return false;
  return pattern.split(".").every((label) => HOSTNAME_LABEL.test(label));
}
