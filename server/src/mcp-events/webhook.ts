import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { McpError } from "./contract.js";

export interface WebhookRequest {
  url: string;
  secret: string;
  previousSecret?: string;
  subscriptionId: string;
  eventId: string;
  body: string;
}
export interface WebhookResponse {
  status: number;
  body: string;
}
export interface WebhookClient {
  verify(url: string, secret: string, subscriptionId: string, signal: AbortSignal): Promise<void>;
  send(input: WebhookRequest, signal: AbortSignal): Promise<WebhookResponse>;
}
export function signingKey(secret: string): Buffer {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new McpError(-32602, "Invalid webhook signing secret.");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    throw new McpError(-32602, "Invalid webhook signing secret.");
  return key;
}
export function normalizeCallbackUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError(-32602, "Invalid webhook callback URL.");
  }
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !url.hostname ||
    /(^|\.)(localhost|local|internal|home|test|invalid)$/i.test(url.hostname)
  )
    throw new McpError(-32602, "Webhook callback requires public HTTPS.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host))
    throw new McpError(-32602, "Webhook callback requires a public address.");
  return url.href;
}
/** Conservative public-unicast policy: reject mapped IPv6, transition and special-purpose ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const prefix = Number.parseInt(address.split(":")[0]!, 16);
  return (
    prefix >= 0x2000 &&
    prefix <= 0x3fff &&
    prefix !== 0x2001 &&
    prefix !== 0x2002 &&
    prefix !== 0x3fff
  );
}
export function webhookHeaders(input: WebhookRequest, now: number): Record<string, string> {
  if (
    Buffer.byteLength(input.body, "utf8") > 256 * 1024 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId) ||
    !/^sub-[a-f0-9]{64}$/.test(input.subscriptionId)
  )
    throw new McpError(-32602, "Invalid webhook envelope.");
  const timestamp = String(Math.floor(now / 1000));
  const signed = `${input.eventId}.${timestamp}.${input.body}`;
  const secrets = [input.secret, ...(input.previousSecret ? [input.previousSecret] : [])];
  const signature = secrets
    .map(
      (secret) =>
        `v1,${createHmac("sha256", signingKey(secret)).update(signed, "utf8").digest("base64")}`,
    )
    .join(" ");
  return {
    "Content-Type": "application/json",
    "webhook-id": input.eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
    "X-MCP-Subscription-Id": input.subscriptionId,
  };
}
export type CallbackResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;
export type PinnedHttpsPost = (
  url: URL,
  address: { address: string; family: number },
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<WebhookResponse>;

/** Node's family auto-selection requests all addresses; return only the checked
 * pin in that callback shape. Never resolve again or substitute another family.
 */
export function createPinnedWebhookLookup(address: {
  address: string;
  family: number;
}): LookupFunction {
  const pinnedAddress = address.address;
  const pinnedFamily = address.family;
  if (!isPublicAddress(pinnedAddress) || pinnedFamily !== isIP(pinnedAddress))
    throw new McpError(-32015, "Webhook destination refused.", "destination");
  return (_hostname, options, callback) => {
    const requestedFamily =
      options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : (options.family ?? 0);
    if (requestedFamily !== 0 && requestedFamily !== pinnedFamily) {
      const error = Object.assign(new Error("Pinned webhook address family does not match."), {
        code: "ENOTFOUND",
      });
      callback(error, options.all ? [] : "");
    } else if (options.all) callback(null, [{ address: pinnedAddress, family: pinnedFamily }]);
    else callback(null, pinnedAddress, pinnedFamily);
  };
}

/** The URL hostname stays in TLS verification and Host; DNS is pinned to a checked public address.
 * https.request does not follow redirects and does not use environment proxies.
 */
const pinnedHttpsPost: PinnedHttpsPost = (url, address, body, headers, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers,
        signal,
        agent: false,
        lookup: createPinnedWebhookLookup(address),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8192) {
            response.destroy();
            reject(new McpError(-32015, "Webhook response exceeds its bound.", "response_size"));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new McpError(-32015, "Webhook callback failed.", "network")),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", () =>
      reject(
        new McpError(-32015, "Webhook callback failed.", signal.aborted ? "timeout" : "network"),
      ),
    );
    req.end(body);
  });

export class PublicHttpsWebhookClient implements WebhookClient {
  constructor(
    readonly resolver: CallbackResolver = (hostname) =>
      lookup(hostname, { all: true, verbatim: true }),
    readonly post: PinnedHttpsPost = pinnedHttpsPost,
    readonly now: () => number = Date.now,
    readonly challenge: () => string = () => randomBytes(32).toString("hex"),
  ) {}
  async send(input: WebhookRequest, externalSignal: AbortSignal): Promise<WebhookResponse> {
    const url = new URL(normalizeCallbackUrl(input.url));
    const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(10_000)]);
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let records: Array<{ address: string; family: number }>;
    try {
      records = await new Promise((resolve, reject) => {
        const abort = () => reject(new McpError(-32015, "Webhook resolution failed.", "timeout"));
        signal.addEventListener("abort", abort, { once: true });
        const resolving = isIP(hostname)
          ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
          : this.resolver(hostname);
        resolving
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort))
          .catch(() => {});
      });
    } catch {
      throw new McpError(-32015, "Webhook resolution failed.", "dns");
    }
    if (
      !records.length ||
      records.length > 32 ||
      records.some(
        (record) => !isPublicAddress(record.address) || record.family !== isIP(record.address),
      )
    )
      throw new McpError(-32015, "Webhook destination refused.", "destination");
    signal.throwIfAborted();
    try {
      return await this.post(
        url,
        records[0]!,
        input.body,
        webhookHeaders(input, this.now()),
        signal,
      );
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(-32015, "Webhook callback failed.", "network");
    }
  }
  async verify(
    url: string,
    secret: string,
    subscriptionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const challenge = this.challenge();
    const response = await this.send(
      {
        url,
        secret,
        subscriptionId,
        eventId: `verification-${challenge}`,
        body: JSON.stringify({ type: "verification", challenge }),
      },
      signal,
    );
    let echoed: unknown;
    try {
      echoed = JSON.parse(response.body).challenge;
    } catch {
      /* fixed refusal below */
    }
    const expected = Buffer.from(challenge),
      actual = typeof echoed === "string" ? Buffer.from(echoed) : Buffer.alloc(0);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new McpError(-32015, "Webhook callback verification failed.", "challenge_failed");
  }
}
