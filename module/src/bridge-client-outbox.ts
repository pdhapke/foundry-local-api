export const MOVEMENT_EVENT_NAME = "foundry-local-api.movement";

const OUTBOX_VERSION = 1;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

export interface BridgeEventSenderIdentity {
  clientId: string;
  userId: string;
  lane: "gm" | "player" | "tv";
}

export interface BridgeEventDeliveryMessage {
  kind: "event";
  event: string;
  payload: unknown;
  delivery: {
    deliveryId: string;
    attempt: number;
    sender: BridgeEventSenderIdentity;
  };
}

export interface BridgeEventAcknowledgement {
  kind: "event-ack";
  deliveryId: string;
  accepted: true;
  clientId: string;
}

export interface BridgeOutboxRecord {
  deliveryId: string;
  event: string;
  payload: unknown;
  sender: BridgeEventSenderIdentity;
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  state: "queued" | "dead-letter";
}

export interface BridgeOutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BridgeEventOutboxOptions {
  storage?: BridgeOutboxStorage;
  storageKey?: string;
  now?: () => number;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
}

export interface BridgeEventOutboxDiagnostics {
  persistence: "durable" | "memory-only" | "unavailable";
  queuedCount: number;
  deadLetterCount: number;
  lastError: "storage-read-failed" | "storage-write-failed" | "storage-corrupt" | null;
}

interface PersistedOutbox {
  version: typeof OUTBOX_VERSION;
  records: BridgeOutboxRecord[];
}

function stablePayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stablePayload(entry)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is BridgeOutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BridgeOutboxRecord>;
  return (
    typeof record.deliveryId === "string" &&
    typeof record.event === "string" &&
    typeof record.sender?.clientId === "string" &&
    typeof record.sender.userId === "string" &&
    (record.sender.lane === "gm" ||
      record.sender.lane === "player" ||
      record.sender.lane === "tv") &&
    typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.attemptCount) &&
    typeof record.nextAttemptAt === "number" &&
    (record.state === "queued" || record.state === "dead-letter")
  );
}

/**
 * Durable, identity-bound client event outbox. Credentials and URLs never enter
 * the persisted shape. Records remain until an exact server acknowledgement is
 * received; exhausting retries makes the failure visible instead of dropping it.
 */
export class BridgeEventOutbox {
  private readonly records = new Map<string, BridgeOutboxRecord>();
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly storage: BridgeOutboxStorage | undefined;
  private readonly storageKey: string;
  private persistence: BridgeEventOutboxDiagnostics["persistence"];
  private lastError: BridgeEventOutboxDiagnostics["lastError"] = null;

  constructor(
    private readonly sender: BridgeEventSenderIdentity,
    options: BridgeEventOutboxOptions = {},
  ) {
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? "foundry-local-api.bridge-event-outbox.v1";
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) {
      throw new Error("Outbox maxAttempts must be a positive safe integer");
    }
    this.persistence = this.storage ? "durable" : "memory-only";
    this.load();
  }

  enqueue(event: string, payload: unknown): BridgeOutboxRecord {
    if (event !== MOVEMENT_EVENT_NAME) throw new Error("Only movement events are durable");
    const eventId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { eventId?: unknown }).eventId === "string"
        ? (payload as { eventId: string }).eventId
        : "";
    if (!eventId || eventId.length > 256) throw new Error("Movement eventId is required");
    const deliveryId = `movement:${this.sender.userId}:${eventId}`;
    const existing = this.records.get(deliveryId);
    if (existing) {
      if (stablePayload(existing.payload) !== stablePayload(payload)) {
        throw new Error("Movement eventId was reused with different payload");
      }
      return structuredClone(existing);
    }
    const now = this.now();
    const record: BridgeOutboxRecord = {
      deliveryId,
      event,
      payload: structuredClone(payload),
      sender: { ...this.sender },
      createdAt: now,
      attemptCount: 0,
      nextAttemptAt: now,
      state: "queued",
    };
    this.records.set(deliveryId, record);
    this.persist();
    return structuredClone(record);
  }

  ready(): BridgeOutboxRecord[] {
    const now = this.now();
    return [...this.records.values()]
      .filter((record) => record.state === "queued" && record.nextAttemptAt <= now)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId),
      )
      .map((record) => structuredClone(record));
  }

  markAttempt(deliveryId: string): BridgeEventDeliveryMessage | null {
    const record = this.records.get(deliveryId);
    if (!record || record.state !== "queued") return null;
    record.attemptCount += 1;
    if (record.attemptCount >= this.maxAttempts) {
      record.state = "dead-letter";
    } else {
      record.nextAttemptAt =
        this.now() +
        Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.max(0, record.attemptCount - 1));
    }
    this.persist();
    return {
      kind: "event",
      event: record.event,
      payload: structuredClone(record.payload),
      delivery: {
        deliveryId: record.deliveryId,
        attempt: record.attemptCount,
        sender: { ...record.sender },
      },
    };
  }

  acknowledge(acknowledgement: BridgeEventAcknowledgement): boolean {
    if (acknowledgement.clientId !== this.sender.clientId) return false;
    const removed = this.records.delete(acknowledgement.deliveryId);
    if (removed) this.persist();
    return removed;
  }

  diagnostics(): BridgeEventOutboxDiagnostics {
    const records = [...this.records.values()];
    return {
      persistence: this.persistence,
      queuedCount: records.filter((record) => record.state === "queued").length,
      deadLetterCount: records.filter((record) => record.state === "dead-letter").length,
      lastError: this.lastError,
    };
  }

  private load(): void {
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      this.persistence = "unavailable";
      this.lastError = "storage-read-failed";
      return;
    }
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedOutbox>;
      if (
        parsed.version !== OUTBOX_VERSION ||
        !Array.isArray(parsed.records) ||
        !parsed.records.every(isRecord)
      ) {
        throw new Error("invalid outbox");
      }
      for (const record of parsed.records) {
        if (
          record.sender.clientId === this.sender.clientId &&
          record.sender.userId === this.sender.userId &&
          record.sender.lane === this.sender.lane
        ) {
          this.records.set(record.deliveryId, structuredClone(record));
        }
      }
    } catch {
      this.persistence = "unavailable";
      this.lastError = "storage-corrupt";
    }
  }

  private persist(): void {
    if (!this.storage || this.persistence === "unavailable") return;
    try {
      const value: PersistedOutbox = {
        version: OUTBOX_VERSION,
        records: [...this.records.values()].map((record) => structuredClone(record)),
      };
      this.storage.setItem(this.storageKey, JSON.stringify(value));
    } catch {
      this.persistence = "unavailable";
      this.lastError = "storage-write-failed";
    }
  }
}

export function isBridgeEventAcknowledgement(value: unknown): value is BridgeEventAcknowledgement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeEventAcknowledgement>;
  return (
    candidate.kind === "event-ack" &&
    candidate.accepted === true &&
    typeof candidate.deliveryId === "string" &&
    typeof candidate.clientId === "string"
  );
}
