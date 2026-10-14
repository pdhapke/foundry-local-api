import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { McpError, type EventDefinition, type EventInput } from "./contract.js";

function subscriptionSchema<F>(filtersSchema: z.ZodType<F>) {
  return z
    .object({
      id: z.string().regex(/^sub-[a-f0-9]{64}$/),
      owner: z.string().min(1).max(256),
      filters: filtersSchema,
      callbackUrl: z.string().max(2048),
      sealedSecret: z.string().min(1).max(16384),
      previousSealedSecret: z.string().min(1).max(16384).optional(),
      rotationUntil: z.number().int().nonnegative().optional(),
      expiresAt: z.number().int().nonnegative(),
      status: z.enum(["active", "stopped"]),
      revision: z.number().int().positive(),
      watermark: z.number().int().nonnegative(),
    })
    .strict();
}
const deliverySchema = z
  .object({
    subscriptionId: z.string(),
    eventId: z.string(),
    sequence: z.number().int().positive(),
    status: z.enum(["queued", "in_flight", "received", "dead_letter", "cancelled"]),
    attempts: z.number().int().nonnegative().max(10),
    nextAttemptAt: z.number().int().nonnegative(),
    leaseUntil: z.number().int().nonnegative().optional(),
    lastReason: z.string().max(64).optional(),
  })
  .strict();
export function eventStoreSchema<F, I extends EventInput>(
  filtersSchema: z.ZodType<F>,
  inputSchema: z.ZodType<I>,
) {
  return z
    .object({
      version: z.literal(1),
      generation: z.string().uuid(),
      nextSequence: z.number().int().positive(),
      events: z
        .array(z.object({ sequence: z.number().int().positive(), input: inputSchema }).strict())
        .max(1024),
      subscriptions: z.array(subscriptionSchema(filtersSchema)).max(64),
      deliveries: z.array(deliverySchema).max(65536),
    })
    .strict();
}
export interface EventSubscription<F> {
  id: string;
  owner: string;
  filters: F;
  callbackUrl: string;
  sealedSecret: string;
  previousSealedSecret?: string;
  rotationUntil?: number;
  expiresAt: number;
  status: "active" | "stopped";
  revision: number;
  watermark: number;
}
export type EventDelivery = z.infer<typeof deliverySchema>;
export interface EventStoreState<F, I extends EventInput> {
  version: 1;
  generation: string;
  nextSequence: number;
  events: Array<{ sequence: number; input: I }>;
  subscriptions: Array<EventSubscription<F>>;
  deliveries: EventDelivery[];
}
export interface EventStore<F, I extends EventInput> {
  read(): EventStoreState<F, I>;
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T;
}
export function initialEventStore<F, I extends EventInput>(): EventStoreState<F, I> {
  return {
    version: 1,
    generation: randomUUID(),
    nextSequence: 1,
    events: [],
    subscriptions: [],
    deliveries: [],
  };
}
function validate<F, I extends EventInput>(
  state: EventStoreState<F, I>,
  filtersSchema: z.ZodType<F>,
  inputSchema: z.ZodType<I>,
): EventStoreState<F, I> {
  const data = eventStoreSchema(filtersSchema, inputSchema).parse(state) as EventStoreState<F, I>;
  const sequences = data.events.map((event) => event.sequence);
  if (
    new Set(sequences).size !== sequences.length ||
    sequences.some(
      (sequence, index) =>
        sequence >= data.nextSequence || (index > 0 && sequence <= sequences[index - 1]!),
    ) ||
    new Set(data.events.map((event) => event.input.eventId)).size !== data.events.length ||
    new Set(data.subscriptions.map((subscription) => subscription.id)).size !==
      data.subscriptions.length ||
    data.subscriptions.some((subscription) => subscription.watermark >= data.nextSequence) ||
    data.deliveries.some(
      (delivery) =>
        !data.subscriptions.some((subscription) => subscription.id === delivery.subscriptionId) ||
        !data.events.some(
          (event) =>
            event.input.eventId === delivery.eventId && event.sequence === delivery.sequence,
        ),
    ) ||
    new Set(data.deliveries.map((delivery) => `${delivery.subscriptionId}:${delivery.eventId}`))
      .size !== data.deliveries.length
  )
    throw new McpError(-32603, "MCP event store is invalid.", "store_invalid");
  return data;
}
/** Synthetic tests only; production must supply persistent private storage. */
export class MemoryEventStore<F, D, I extends EventInput, V> implements EventStore<F, I> {
  #state: EventStoreState<F, I>;
  constructor(
    readonly definition: EventDefinition<F, D, I, V>,
    state: EventStoreState<F, I> = initialEventStore(),
  ) {
    this.#state = validate(state, definition.filtersSchema, definition.inputSchema);
  }
  read(): EventStoreState<F, I> {
    return structuredClone(this.#state);
  }
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T {
    const next = this.read();
    const result = operation(next);
    this.#state = validate(next, this.definition.filtersSchema, this.definition.inputSchema);
    return structuredClone(result);
  }
}
/** Single-runtime writer; pending-file lock and source digest reject competing writers.
 * Private Windows ACL/encrypted secret codec checks are supplied by reviewed wiring.
 * No directory is created and no old pending/lock file is removed automatically.
 */
export class FileEventStore<F, D, I extends EventInput, V> implements EventStore<F, I> {
  #state: EventStoreState<F, I>;
  #diskDigest: string | null;
  readonly #path: string;
  constructor(
    path: string,
    readonly assertPrivateStorage: (path: string) => void,
    readonly definition: EventDefinition<F, D, I, V>,
  ) {
    if (typeof assertPrivateStorage !== "function")
      throw new McpError(-32603, "Private storage verifier required.");
    this.#path = resolve(path);
    this.checkPath();
    const bytes = existsSync(this.#path) ? readFileSync(this.#path) : null;
    if (bytes && bytes.length > 16 * 1024 * 1024)
      throw new McpError(-32603, "MCP event store exceeds its bound.");
    try {
      this.#state = bytes
        ? validate(
            JSON.parse(bytes.toString("utf8")),
            definition.filtersSchema,
            definition.inputSchema,
          )
        : initialEventStore<F, I>();
    } catch {
      throw new McpError(-32603, "MCP event store is invalid.", "store_invalid");
    }
    this.#diskDigest = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  }
  private checkPath(): void {
    this.assertPrivateStorage(this.#path);
    const parent = dirname(this.#path);
    if (
      realpathSync(parent) !== parent ||
      lstatSync(parent).isSymbolicLink() ||
      !lstatSync(parent).isDirectory() ||
      (existsSync(this.#path) &&
        (lstatSync(this.#path).isSymbolicLink() || !lstatSync(this.#path).isFile()))
    )
      throw new McpError(-32603, "Unsafe MCP event storage path.", "store_path");
  }
  read(): EventStoreState<F, I> {
    this.checkPath();
    return structuredClone(this.#state);
  }
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T {
    const next = this.read();
    const result = operation(next);
    const bytes = Buffer.from(
      JSON.stringify(validate(next, this.definition.filtersSchema, this.definition.inputSchema)),
      "utf8",
    );
    if (bytes.length > 16 * 1024 * 1024)
      throw new McpError(-32603, "MCP event store exceeds its bound.");
    const pending = `${this.#path}.pending`;
    let fd: number;
    try {
      fd = openSync(pending, "wx", 0o600);
    } catch {
      throw new McpError(-32603, "MCP event store has an unresolved write.", "store_busy");
    }
    let committed = false;
    try {
      this.checkPath();
      const diskDigest = existsSync(this.#path)
        ? createHash("sha256").update(readFileSync(this.#path)).digest("hex")
        : null;
      if (diskDigest !== this.#diskDigest)
        throw new McpError(-32603, "MCP event store changed externally.", "store_conflict");
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      this.assertPrivateStorage(pending);
      renameSync(pending, this.#path);
      committed = true;
      this.#state = next;
      this.#diskDigest = createHash("sha256").update(bytes).digest("hex");
      return structuredClone(result);
    } finally {
      if (fd >= 0) closeSync(fd);
      // Only this operation's exclusively-created temporary file may be cleaned up.
      if (!committed) unlinkSync(pending);
    }
  }
}
