import { createHash } from "node:crypto";
import { z } from "zod";
import { McpError, type EventDefinition, type EventInput, type EventEnvelope } from "./contract.js";
import type { EventStore, EventStoreState, EventSubscription } from "./store.js";
import { normalizeCallbackUrl, signingKey, type WebhookClient } from "./webhook.js";

export interface EventSecretCodec {
  seal(secret: string): string;
  unseal(encoded: string): string;
}
export interface EventServiceOptions<F, D, I extends EventInput, V> {
  definition: EventDefinition<F, D, I, V>;
  store: EventStore<F, I>;
  codec: EventSecretCodec;
  webhooks: WebhookClient;
  authorizeSubscription(owner: string, filters: F): boolean | Promise<boolean>;
  authorizeIngress(input: I, identity: V): boolean;
  canDeliver(owner: string, data: D): boolean | Promise<boolean>;
  now?: () => number;
  maxEvents?: number;
  maxAttempts?: number;
}
export interface SubscriptionResult {
  id: string;
  refreshBefore: string;
  cursor: string;
  truncated: boolean;
}
const terminal = new Set(["received", "dead_letter", "cancelled"]);
function subscriptionId(
  owner: string,
  name: string,
  canonicalFilters: string,
  url: string,
): string {
  return `sub-${createHash("sha256")
    .update(JSON.stringify([owner, name, canonicalFilters, url]))
    .digest("hex")}`;
}
export function eventCursor(state: { generation: string }, sequence: number): string {
  // Opaque legacy prefix is retained so existing durable cursors remain usable.
  return `dot1.${state.generation}.${sequence}`;
}
function parseCursor<F, I extends EventInput>(
  value: string,
  state: EventStoreState<F, I>,
): { sequence: number; truncated: boolean } {
  const match = /^dot1\.([a-f0-9-]{36})\.(0|[1-9][0-9]*)$/.exec(value);
  if (
    !match ||
    !z.string().uuid().safeParse(match[1]).success ||
    !Number.isSafeInteger(Number(match[2]))
  )
    throw new McpError(-32602, "Invalid MCP event cursor.");
  const sequence = Number(match[2]);
  const floor = (state.events[0]?.sequence ?? state.nextSequence) - 1;
  if (match[1] !== state.generation || sequence < floor)
    return { sequence: floor, truncated: true };
  if (sequence >= state.nextSequence)
    throw new McpError(-32602, "MCP event cursor is ahead of history.");
  return { sequence, truncated: false };
}
function advance<F, D, I extends EventInput, V>(
  state: EventStoreState<F, I>,
  subscription: EventSubscription<F>,
  definition: EventDefinition<F, D, I, V>,
): void {
  for (const event of state.events) {
    if (event.sequence <= subscription.watermark) continue;
    if (definition.matchesFilters(definition.data(event.input), subscription.filters)) {
      const delivery = state.deliveries.find(
        (item) => item.subscriptionId === subscription.id && item.eventId === event.input.eventId,
      );
      if (!delivery || !terminal.has(delivery.status)) break;
    }
    subscription.watermark = event.sequence;
  }
}
function stop<F, D, I extends EventInput, V>(
  state: EventStoreState<F, I>,
  subscription: EventSubscription<F>,
  reason: string,
  definition: EventDefinition<F, D, I, V>,
): void {
  subscription.status = "stopped";
  subscription.revision++;
  for (const delivery of state.deliveries) {
    if (
      delivery.subscriptionId === subscription.id &&
      (!terminal.has(delivery.status) ||
        (reason !== "expired" &&
          delivery.status === "cancelled" &&
          delivery.lastReason === "expired"))
    ) {
      // Explicit stop/revocation remains authoritative even after expiry has
      // provisionally cancelled a delivery that could otherwise be replayed.
      delivery.status = "cancelled";
      delivery.lastReason = reason;
      delete delivery.leaseUntil;
    }
  }
  advance(state, subscription, definition);
}

export class EventService<F, D, I extends EventInput, V> {
  readonly #now: () => number;
  readonly #maxEvents: number;
  readonly #maxAttempts: number;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #sending = new Map<string, AbortController>();
  readonly #verified = new Map<string, { secretDigest: string; expiresAt: number }>();
  #cancelGeneration = 0;
  constructor(readonly options: EventServiceOptions<F, D, I, V>) {
    const definition = options.definition;
    if (
      !definition ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(definition.name) ||
      typeof definition.description !== "string" ||
      definition.description.length > 2048 ||
      !definition.filtersSchema ||
      !definition.dataSchema ||
      !definition.inputSchema ||
      !definition.identitySchema ||
      typeof definition.eventId !== "function" ||
      typeof definition.data !== "function" ||
      typeof definition.canonicalFilters !== "function" ||
      typeof definition.matchesFilters !== "function" ||
      typeof definition.sameScope !== "function" ||
      typeof definition.validateOccurrence !== "function" ||
      !options.store ||
      !options.codec ||
      typeof options.codec.seal !== "function" ||
      typeof options.codec.unseal !== "function" ||
      !options.webhooks ||
      typeof options.authorizeSubscription !== "function" ||
      typeof options.authorizeIngress !== "function" ||
      typeof options.canDeliver !== "function"
    )
      throw new McpError(-32603, "MCP event security callbacks required.");
    this.#now = options.now ?? Date.now;
    this.#maxEvents = options.maxEvents ?? 1024;
    this.#maxAttempts = options.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.#maxEvents) ||
      this.#maxEvents < 1 ||
      this.#maxEvents > 1024 ||
      !Number.isInteger(this.#maxAttempts) ||
      this.#maxAttempts < 1 ||
      this.#maxAttempts > 10
    )
      throw new McpError(-32602, "Invalid MCP event bounds.");
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => {});
    return next;
  }
  private owner(value: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(value))
      throw new McpError(-32602, "Invalid authenticated event principal.");
    return value;
  }
  async list(owner: string, filters?: F): Promise<unknown[]> {
    this.owner(owner);
    if (
      !filters ||
      (await this.options.authorizeSubscription(
        owner,
        this.options.definition.filtersSchema.parse(filters),
      )) !== true
    )
      return [];
    return [
      {
        name: this.options.definition.name,
        description: this.options.definition.description,
        delivery: ["webhook"],
        inputSchema: z.toJSONSchema(this.options.definition.filtersSchema),
        payloadSchema: z.toJSONSchema(this.options.definition.dataSchema),
      },
    ];
  }
  async subscribe(owner: string, raw: unknown, signal: AbortSignal): Promise<SubscriptionResult> {
    this.owner(owner);
    const parsed = z
      .object({
        name: z.literal(this.options.definition.name),
        arguments: this.options.definition.filtersSchema,
        delivery: z
          .object({
            mode: z.literal("webhook"),
            url: z.string().max(2048),
            secret: z.string().max(128),
          })
          .strict(),
        cursor: z.string().max(128).nullable().optional(),
        ttlMs: z.number().int().min(1000).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new McpError(-32602, "Invalid event subscription.");
    const input = parsed.data;
    const url = normalizeCallbackUrl(input.delivery.url);
    signingKey(input.delivery.secret);
    // Capture at invocation, before the operation queues or yields. A stop that
    // overtakes this request must remain authoritative when authorization resumes.
    const generation = this.#cancelGeneration;
    return this.exclusive(async () => {
      signal.throwIfAborted();
      if (this.#cancelGeneration !== generation)
        throw new McpError(-32003, "MCP event subscription was cancelled.");
      if ((await this.options.authorizeSubscription(owner, input.arguments)) !== true)
        throw new McpError(-32003, "MCP event scope is not authorized.");
      signal.throwIfAborted();
      if (this.#cancelGeneration !== generation)
        throw new McpError(-32003, "MCP event subscription was cancelled.");
      const id = subscriptionId(
        owner,
        this.options.definition.name,
        this.options.definition.canonicalFilters(input.arguments),
        url,
      );
      const nowBefore = this.#now();
      const before = this.options.store.read();
      if (
        !before.subscriptions.some(
          (item) => item.id === id && item.status === "active" && item.expiresAt > nowBefore,
        ) &&
        before.subscriptions.filter(
          (item) => item.status === "active" && item.expiresAt > nowBefore,
        ).length >= 8
      )
        throw new McpError(-32000, "Event subscription capacity reached.");
      // Cache only a verified principal/URL/key combination, never a replacement key.
      const verificationKey = JSON.stringify([owner, url]);
      const secretDigest = createHash("sha256").update(input.delivery.secret).digest("hex");
      for (const [key, value] of this.#verified)
        if (value.expiresAt <= nowBefore) this.#verified.delete(key);
      const verified = this.#verified.get(verificationKey);
      if (!verified || verified.secretDigest !== secretDigest)
        await this.options.webhooks.verify(url, input.delivery.secret, id, signal);
      signal.throwIfAborted();
      if (this.#cancelGeneration !== generation)
        throw new McpError(-32003, "MCP event subscription was cancelled.");
      if ((await this.options.authorizeSubscription(owner, input.arguments)) !== true)
        throw new McpError(-32003, "MCP event scope is no longer authorized.");
      signal.throwIfAborted();
      if (this.#cancelGeneration !== generation)
        throw new McpError(-32003, "MCP event subscription was cancelled.");
      const now = this.#now();
      const expiresAt = now + Math.min(input.ttlMs ?? 3600000, 3600000);
      const sealedSecret = this.options.codec.seal(input.delivery.secret);
      if (!sealedSecret || sealedSecret.includes(input.delivery.secret))
        throw new McpError(-32603, "Secret codec must protect webhook credentials.");
      const result = this.options.store.transact((state) => {
        for (const entry of state.subscriptions)
          if (entry.status === "active" && entry.expiresAt <= now)
            stop(state, entry, "expired", this.options.definition);
        let subscription = state.subscriptions.find((item) => item.id === id);
        const replay = input.cursor
          ? parseCursor(input.cursor, state)
          : subscription
            ? parseCursor(eventCursor(state, subscription.watermark), state)
            : { sequence: state.nextSequence - 1, truncated: false };
        if (subscription) {
          if (this.options.codec.unseal(subscription.sealedSecret) !== input.delivery.secret) {
            subscription.previousSealedSecret = subscription.sealedSecret;
            subscription.rotationUntil = now + 60000;
          }
          subscription.sealedSecret = sealedSecret;
          subscription.expiresAt = expiresAt;
          subscription.status = "active";
          subscription.revision++;
          // A refresh cursor can never move past unfinished deliveries.
          subscription.watermark = replay.truncated
            ? replay.sequence
            : Math.min(subscription.watermark, replay.sequence);
        } else {
          // Retain up to 64 identities for bounded replay/deduplication; retired slots
          // cannot exhaust the separate eight-active-subscription allowance.
          if (state.subscriptions.length >= 64) {
            const retired = state.subscriptions
              .filter((item) => item.status === "stopped")
              .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))[0];
            if (!retired) throw new McpError(-32000, "Event subscription capacity reached.");
            state.subscriptions = state.subscriptions.filter((item) => item.id !== retired.id);
            state.deliveries = state.deliveries.filter(
              (item) => item.subscriptionId !== retired.id,
            );
          }
          subscription = {
            id,
            owner,
            filters: input.arguments,
            callbackUrl: url,
            sealedSecret,
            expiresAt,
            status: "active",
            revision: 1,
            watermark: replay.sequence,
          };
          state.subscriptions.push(subscription);
        }
        for (const event of state.events) {
          if (
            event.sequence <= subscription.watermark ||
            !this.options.definition.matchesFilters(
              this.options.definition.data(event.input),
              subscription.filters,
            )
          )
            continue;
          const existing = state.deliveries.find(
            (item) => item.subscriptionId === id && item.eventId === event.input.eventId,
          );
          if (existing) {
            // A saved cursor may resume expiry-cancelled work. Other terminal
            // records stay terminal, and refresh never resets the retry budget.
            if (
              input.cursor &&
              existing.status === "cancelled" &&
              existing.lastReason === "expired" &&
              existing.attempts < this.#maxAttempts
            ) {
              existing.status = "queued";
              existing.nextAttemptAt = Math.max(now, existing.nextAttemptAt);
              delete existing.lastReason;
              delete existing.leaseUntil;
            }
            continue;
          }
          state.deliveries.push({
            subscriptionId: id,
            eventId: event.input.eventId,
            sequence: event.sequence,
            status: "queued",
            attempts: 0,
            nextAttemptAt: now,
          });
        }
        advance(state, subscription, this.options.definition);
        return {
          id,
          refreshBefore: new Date(expiresAt).toISOString(),
          cursor: eventCursor(state, subscription.watermark),
          truncated: replay.truncated,
        };
      });
      this.#verified.delete(verificationKey);
      if (this.#verified.size >= 64) this.#verified.delete(this.#verified.keys().next().value!);
      this.#verified.set(verificationKey, {
        secretDigest,
        expiresAt: verified?.secretDigest === secretDigest ? verified.expiresAt : now + 300000,
      });
      return result;
    });
  }
  async unsubscribe(owner: string, raw: unknown): Promise<Record<string, never>> {
    this.owner(owner);
    const parsed = z
      .object({
        name: z.literal(this.options.definition.name),
        arguments: this.options.definition.filtersSchema,
        delivery: z.object({ mode: z.literal("webhook"), url: z.string().max(2048) }).strict(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new McpError(-32602, "Invalid event unsubscribe.");
    const input = parsed.data;
    const id = subscriptionId(
      owner,
      this.options.definition.name,
      this.options.definition.canonicalFilters(input.arguments),
      normalizeCallbackUrl(input.delivery.url),
    );
    this.#cancelGeneration++;
    this.#sending.get(id)?.abort();
    // Revoked principals may still stop their own exact subscription. Do not wait for delivery.
    this.options.store.transact((state) => {
      const subscription = state.subscriptions.find(
        (item) => item.id === id && item.owner === owner,
      );
      if (subscription) stop(state, subscription, "unsubscribed", this.options.definition);
    });
    return {};
  }
  enqueue(raw: unknown, identity: V): { eventId: string; cursor: string; replayed: boolean } {
    const parsed = this.options.definition.inputSchema.safeParse(raw);
    const sender = this.options.definition.identitySchema.safeParse(identity);
    if (!parsed.success || !sender.success) throw new McpError(-32602, "Invalid event ingress.");
    const input = parsed.data;
    const data = this.options.definition.data(input);
    if (
      input.eventId !== this.options.definition.eventId(data) ||
      !this.options.definition.validateOccurrence(input, this.#now())
    )
      throw new McpError(-32602, "Event identity or occurrence is invalid.");
    if (this.options.authorizeIngress(input, sender.data) !== true)
      throw new McpError(-32003, "Event ingress is not authorized.");
    return this.options.store.transact((state) => {
      const existing = state.events.find((event) => event.input.eventId === input.eventId);
      if (existing)
        return {
          eventId: input.eventId,
          cursor: eventCursor(state, existing.sequence),
          replayed: true,
        };
      while (state.events.length >= this.#maxEvents) {
        const oldest = state.events[0]!;
        if (
          state.deliveries.some(
            (item) => item.sequence === oldest.sequence && !terminal.has(item.status),
          )
        )
          throw new McpError(
            -32000,
            "MCP event queue is full; pending delivery cannot be discarded.",
          );
        state.events.shift();
        state.deliveries = state.deliveries.filter((item) => item.sequence !== oldest.sequence);
      }
      const sequence = state.nextSequence++;
      state.events.push({ sequence, input });
      for (const subscription of state.subscriptions) {
        if (subscription.status !== "active" || subscription.expiresAt <= this.#now()) {
          if (subscription.status === "active")
            stop(state, subscription, "expired", this.options.definition);
          continue;
        }
        if (this.options.definition.matchesFilters(data, subscription.filters))
          state.deliveries.push({
            subscriptionId: subscription.id,
            eventId: input.eventId,
            sequence,
            status: "queued",
            attempts: 0,
            nextAttemptAt: this.#now(),
          });
        advance(state, subscription, this.options.definition);
      }
      return { eventId: input.eventId, cursor: eventCursor(state, sequence), replayed: false };
    });
  }
  /** One explicit bounded pump pass. No timers or network activity occur on construction. */
  async dispatchDue(
    externalSignal: AbortSignal,
    limit = 8,
  ): Promise<{ attempted: number; received: number; deadLettered: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new McpError(-32602, "Invalid delivery pass limit.");
    return this.exclusive(async () => {
      const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(20000)]);
      const result = { attempted: 0, received: 0, deadLettered: 0 };
      this.options.store.transact((state) => {
        for (const subscription of state.subscriptions)
          if (subscription.status === "active" && subscription.expiresAt <= this.#now())
            stop(state, subscription, "expired", this.options.definition);
        for (const item of state.deliveries)
          if (item.status === "in_flight" && (item.leaseUntil ?? 0) <= this.#now()) {
            item.status = "queued";
            delete item.leaseUntil;
          }
      });
      const snapshot = this.options.store.read();
      for (const item of snapshot.deliveries) {
        if (signal.aborted || result.attempted >= limit) break;
        if (item.status !== "queued" || item.nextAttemptAt > this.#now()) continue;
        // Per-subscription order: never deliver beyond an unfinished earlier matching event.
        if (
          snapshot.deliveries.some(
            (earlier) =>
              earlier.subscriptionId === item.subscriptionId &&
              earlier.sequence < item.sequence &&
              !terminal.has(earlier.status),
          )
        )
          continue;
        const subscription = snapshot.subscriptions.find(
          (entry) => entry.id === item.subscriptionId,
        )!;
        const event = snapshot.events.find((entry) => entry.input.eventId === item.eventId)!;
        const data = this.options.definition.data(event.input);
        if (subscription.status !== "active") continue;
        const generation = this.#cancelGeneration;
        if (
          (await this.options.authorizeSubscription(subscription.owner, subscription.filters)) !==
            true ||
          (await this.options.canDeliver(subscription.owner, data)) !== true
        ) {
          this.options.store.transact((state) => {
            const current = state.subscriptions.find((entry) => entry.id === subscription.id);
            if (current?.status === "active" && current.revision === subscription.revision)
              stop(state, current, "scope_inactive", this.options.definition);
          });
          continue;
        }
        signal.throwIfAborted();
        const attempt = this.options.store.transact((state) => {
          const current = state.subscriptions.find((entry) => entry.id === subscription.id);
          const stored = state.deliveries.find(
            (entry) =>
              entry.subscriptionId === item.subscriptionId && entry.eventId === item.eventId,
          );
          if (
            generation !== this.#cancelGeneration ||
            !current ||
            current.status !== "active" ||
            current.revision !== subscription.revision ||
            current.expiresAt <= this.#now() ||
            !stored ||
            stored.status !== "queued" ||
            stored.nextAttemptAt > this.#now() ||
            state.deliveries.some(
              (earlier) =>
                earlier.subscriptionId === item.subscriptionId &&
                earlier.sequence < item.sequence &&
                !terminal.has(earlier.status),
            )
          )
            return null;
          stored.status = "in_flight";
          stored.attempts++;
          stored.leaseUntil = this.#now() + 25000;
          return stored.attempts;
        });
        if (attempt === null) continue;
        result.attempted++;
        const sending = new AbortController();
        this.#sending.set(subscription.id, sending);
        const envelope: EventEnvelope<D> = {
          eventId: event.input.eventId,
          name: this.options.definition.name,
          timestamp: event.input.timestamp,
          data,
          cursor: eventCursor(snapshot, event.sequence),
        };
        let status = 0;
        let reason = "network";
        try {
          const previousSecret =
            subscription.previousSealedSecret && (subscription.rotationUntil ?? 0) > this.#now()
              ? this.options.codec.unseal(subscription.previousSealedSecret)
              : undefined;
          const response = await this.options.webhooks.send(
            {
              url: subscription.callbackUrl,
              secret: this.options.codec.unseal(subscription.sealedSecret),
              subscriptionId: subscription.id,
              ...(previousSecret ? { previousSecret } : {}),
              eventId: envelope.eventId,
              body: JSON.stringify(envelope),
            },
            AbortSignal.any([signal, sending.signal]),
          );
          status = response.status;
          reason = `http_${status}`;
        } catch (error) {
          reason = error instanceof McpError ? (error.reason ?? "callback") : "callback";
        } finally {
          this.#sending.delete(subscription.id);
        }
        this.options.store.transact((state) => {
          const stored = state.deliveries.find(
            (entry) =>
              entry.subscriptionId === item.subscriptionId && entry.eventId === item.eventId,
          );
          const current = state.subscriptions.find((entry) => entry.id === subscription.id);
          if (
            !stored ||
            !current ||
            current.status !== "active" ||
            current.revision !== subscription.revision ||
            stored.status !== "in_flight"
          )
            return;
          if (current.expiresAt <= this.#now()) {
            stop(state, current, "expired", this.options.definition);
            return;
          }
          delete stored.leaseUntil;
          stored.lastReason = reason;
          if (status >= 200 && status < 300) {
            stored.status = "received";
            result.received++;
          } else if (
            attempt >= this.#maxAttempts ||
            status === 410 ||
            status === 413 ||
            (status >= 300 && status < 500 && status !== 408 && status !== 429)
          ) {
            stored.status = "dead_letter";
            result.deadLettered++;
          } else {
            stored.status = "queued";
            stored.nextAttemptAt = this.#now() + Math.min(60000, 1000 * 2 ** (attempt - 1));
          }
          advance(
            state,
            state.subscriptions.find((entry) => entry.id === subscription.id)!,
            this.options.definition,
          );
        });
        if (status === 410)
          this.options.store.transact((state) => {
            const current = state.subscriptions.find((entry) => entry.id === subscription.id);
            if (current?.status === "active" && current.revision === subscription.revision)
              stop(state, current, "callback_gone", this.options.definition);
          });
      }
      return result;
    });
  }
  /** Local operator stop; never exposed as an unauthenticated MCP control. */
  stopScope(filters: F): void {
    const scope = this.options.definition.filtersSchema.parse(filters);
    this.#cancelGeneration++;
    this.options.store.transact((state) => {
      for (const subscription of state.subscriptions)
        if (this.options.definition.sameScope(subscription.filters, scope)) {
          this.#sending.get(subscription.id)?.abort();
          stop(state, subscription, "operator_stop", this.options.definition);
        }
    });
  }
}
