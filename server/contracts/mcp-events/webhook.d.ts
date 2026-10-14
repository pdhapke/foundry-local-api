import { type LookupFunction } from "node:net";
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
export declare function signingKey(secret: string): Buffer;
export declare function normalizeCallbackUrl(value: string): string;
/** Conservative public-unicast policy: reject mapped IPv6, transition and special-purpose ranges. */
export declare function isPublicAddress(address: string): boolean;
export declare function webhookHeaders(input: WebhookRequest, now: number): Record<string, string>;
export type CallbackResolver = (hostname: string) => Promise<
  Array<{
    address: string;
    family: number;
  }>
>;
export type PinnedHttpsPost = (
  url: URL,
  address: {
    address: string;
    family: number;
  },
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<WebhookResponse>;
/** Node's family auto-selection requests all addresses; return only the checked
 * pin in that callback shape. Never resolve again or substitute another family.
 */
export declare function createPinnedWebhookLookup(address: {
  address: string;
  family: number;
}): LookupFunction;
export declare class PublicHttpsWebhookClient implements WebhookClient {
  readonly resolver: CallbackResolver;
  readonly post: PinnedHttpsPost;
  readonly now: () => number;
  readonly challenge: () => string;
  constructor(
    resolver?: CallbackResolver,
    post?: PinnedHttpsPost,
    now?: () => number,
    challenge?: () => string,
  );
  send(input: WebhookRequest, externalSignal: AbortSignal): Promise<WebhookResponse>;
  verify(url: string, secret: string, subscriptionId: string, signal: AbortSignal): Promise<void>;
}
