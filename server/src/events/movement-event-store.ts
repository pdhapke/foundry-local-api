import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  buildMovementEvent,
  type CompactMovementEvent,
  type MovementCursorQuery,
  type MovementEventPage,
  type SequencedMovementEvent,
} from "@foundry-local-api/shared";

interface State {
  version: 2;
  generation: string;
  nextSequence: number;
  events: SequencedMovementEvent[];
  eventSequences: Record<string, number>;
  eventHashes: Record<string, string>;
}

export type MovementStoreIssueCode =
  | "STORE_NOT_CONFIGURED"
  | "STORE_FILE_UNREADABLE"
  | "STORE_READ_LIMIT_EXCEEDED"
  | "STORE_INVALID_JSON"
  | "STORE_UNSUPPORTED_VERSION"
  | "STORE_SCHEMA_MISMATCH"
  | "STORE_DIGEST_MISMATCH"
  | "STORE_CURSOR_RECONCILIATION_GAP";

export interface MovementStoreDiagnostics {
  configured: boolean;
  runtimeAvailable: boolean;
  readable: boolean;
  valid: boolean;
  version: number | null;
  generation: string | null;
  eventCount: number | null;
  nextSequence: number | null;
  issueCodes: MovementStoreIssueCode[];
}
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const boundedText = z.string().min(1).max(512);
const finite = z.number().finite();
const point = z.object({ x: finite, y: finite, elevation: finite.optional() }).strict();
const movementField = z.enum(["x", "y", "elevation"]);
const transition = z
  .object({
    regionId: boundedText,
    regionName: z.string().max(512).optional(),
    category: z.enum(["hazard", "threshold", "exit", "room", "corridor", "other"]),
    stopOnEnter: z.literal(true).optional(),
    kind: z.enum(["enter", "exit"]),
    segmentIndex: z.number().int().nonnegative(),
    t: finite,
    point,
  })
  .strict();
const eventSchema = z
  .object({
    eventId: boundedText,
    eventType: z.literal("token_movement"),
    movementFields: z.array(movementField).max(3),
    sceneId: boundedText,
    tokenId: boundedText,
    userId: boundedText,
    timestamp: finite,
    from: point,
    to: point,
    footprint: z.object({ width: finite.nonnegative(), height: finite.nonnegative() }).strict(),
    geometryStatus: z.enum(["complete", "incomplete"]),
    incompleteReasons: z.array(z.string().max(512)).max(256),
    deltas: z.array(z.object({ dx: finite, dy: finite, delevation: finite }).strict()).max(255),
    waypoints: z.array(point).min(2).max(256),
    segments: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            from: point,
            to: point,
            dx: finite,
            dy: finite,
            delevation: finite,
          })
          .strict(),
      )
      .max(255),
    transitions: z.array(transition).max(16_384),
    firstStop: transition.optional(),
    acceptedPoint: point,
    remainingPath: z.array(point).max(256),
    pendingMovement: z
      .object({
        status: z.literal("pending"),
        stop: transition,
        acceptedPoint: point,
        remainingPath: z.array(point).max(256),
      })
      .strict()
      .optional(),
    provenance: z
      .object({
        reporterClientId: boundedText,
        reporterUserId: boundedText,
        reporterLane: z.enum(["gm", "player", "tv"]),
      })
      .strict()
      .optional(),
    sequence: z.number().int().positive(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(2),
    generation: boundedText,
    nextSequence: z.number().int().positive(),
    events: z.array(eventSchema).max(20_000),
    eventSequences: z.record(z.string(), z.number().int().positive()),
    eventHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readBounded(path: string, maxBytes = MAX_STORE_BYTES): string {
  const descriptor = openSync(path, "r");
  try {
    const statistics = fstatSync(descriptor);
    if (!statistics.isFile()) throw new Error("Movement event store path is not a regular file.");
    const size = statistics.size;
    if (!Number.isSafeInteger(size) || size > maxBytes)
      throw new RangeError(`Movement event store exceeds the ${maxBytes}-byte read limit.`);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, buffer, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}
function validState(value: unknown): value is State {
  return stateSchema.safeParse(value).success;
}
function integrityIssues(state: State): MovementStoreIssueCode[] {
  const issueCodes: MovementStoreIssueCode[] = [];
  const sequences = state.events.map((event) => event.sequence);
  const indexedSequences = Object.values(state.eventSequences).sort((left, right) => left - right);
  const indexedIds = Object.keys(state.eventSequences).sort();
  const hashedIds = Object.keys(state.eventHashes).sort();
  const unexplainedIndexGap =
    indexedSequences.length !== state.nextSequence - 1 ||
    indexedSequences.some((sequence, index) => sequence !== index + 1);
  if (
    sequences.some((sequence, index) => index > 0 && sequence !== sequences[index - 1]! + 1) ||
    (sequences.length > 0 && sequences.at(-1)! !== state.nextSequence - 1) ||
    unexplainedIndexGap ||
    indexedIds.length !== hashedIds.length ||
    indexedIds.some((id, index) => id !== hashedIds[index]) ||
    state.events.some((event) => state.eventSequences[event.eventId] !== event.sequence)
  )
    issueCodes.push("STORE_CURSOR_RECONCILIATION_GAP");
  if (
    state.events.some((event) => {
      const { sequence: _sequence, ...compact } = event;
      return state.eventHashes[event.eventId] !== digest(compact);
    })
  )
    issueCodes.push("STORE_DIGEST_MISMATCH");
  return issueCodes;
}
const digest = (event: CompactMovementEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");

export class MovementEventStore {
  private state: State;
  private migrationNeeded = false;
  constructor(
    private readonly path: string,
    private readonly capacity = 2000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("Movement event capacity must be a positive integer.");
    this.state = this.load();
    if (this.migrationNeeded) this.save();
  }
  get sessionId() {
    return this.state.generation;
  }
  get generation() {
    return this.state.generation;
  }
  static diagnose(
    path: string,
    configured = true,
    runtimeAvailable = configured,
    maxBytes = MAX_STORE_BYTES,
  ): MovementStoreDiagnostics {
    const base = {
      configured,
      runtimeAvailable,
      readable: false,
      valid: false,
      version: null,
      generation: null,
      eventCount: null,
      nextSequence: null,
    };
    if (!configured) return { ...base, issueCodes: ["STORE_NOT_CONFIGURED"] };
    let raw: string;
    try {
      raw = readBounded(path, maxBytes);
    } catch (error) {
      if (error instanceof RangeError)
        return { ...base, issueCodes: ["STORE_READ_LIMIT_EXCEEDED"] };
      return { ...base, issueCodes: ["STORE_FILE_UNREADABLE"] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...base, readable: true, issueCodes: ["STORE_INVALID_JSON"] };
    }
    if (!isRecord(parsed))
      return { ...base, readable: true, issueCodes: ["STORE_SCHEMA_MISMATCH"] };
    const version = typeof parsed["version"] === "number" ? parsed["version"] : null;
    const generation = typeof parsed["generation"] === "string" ? parsed["generation"] : null;
    const events = Array.isArray(parsed["events"]) ? parsed["events"] : null;
    const nextSequence = Number.isSafeInteger(parsed["nextSequence"])
      ? (parsed["nextSequence"] as number)
      : null;
    const metadata = {
      ...base,
      readable: true,
      version,
      generation,
      eventCount: events?.length ?? null,
      nextSequence,
    };
    if (version !== null && version !== 2)
      return { ...metadata, issueCodes: ["STORE_UNSUPPORTED_VERSION"] };
    if (version !== 2) return { ...metadata, issueCodes: ["STORE_SCHEMA_MISMATCH"] };
    if (!validState(parsed)) return { ...metadata, issueCodes: ["STORE_SCHEMA_MISMATCH"] };

    const issueCodes = integrityIssues(parsed);
    return { ...metadata, valid: issueCodes.length === 0, issueCodes };
  }
  diagnose(): MovementStoreDiagnostics {
    return MovementEventStore.diagnose(this.path);
  }
  private load(): State {
    let raw: string;
    try {
      raw = readBounded(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.migrationNeeded = true;
        return {
          version: 2,
          generation: randomUUID(),
          nextSequence: 1,
          events: [],
          eventSequences: {},
          eventHashes: {},
        };
      }
      throw new Error(`Unable to read movement event store: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Movement event store is corrupt: ${(error as Error).message}`);
    }
    if (
      isRecord(parsed) &&
      parsed["version"] === undefined &&
      Number.isSafeInteger(parsed["nextSequence"]) &&
      Array.isArray(parsed["events"])
    ) {
      const events: SequencedMovementEvent[] = [];
      for (const item of parsed["events"]) {
        if (
          !isRecord(item) ||
          typeof item["eventId"] !== "string" ||
          typeof item["sceneId"] !== "string" ||
          typeof item["tokenId"] !== "string" ||
          typeof item["userId"] !== "string" ||
          !Number.isSafeInteger(item["sequence"]) ||
          !Array.isArray(item["waypoints"])
        )
          throw new Error(
            "Movement event store has an invalid legacy schema; explicit reconciliation is required.",
          );
        const built = buildMovementEvent({
          eventId: item["eventId"],
          sceneId: item["sceneId"],
          tokenId: item["tokenId"],
          userId: item["userId"],
          timestamp: typeof item["timestamp"] === "number" ? item["timestamp"] : 0,
          waypoints: item["waypoints"] as CompactMovementEvent["waypoints"],
          regions: [],
        });
        events.push({ ...built, sequence: item["sequence"] as number });
      }
      if (
        events.some((event, index) => index > 0 && event.sequence <= events[index - 1]!.sequence) ||
        (parsed["nextSequence"] as number) <= Math.max(0, ...events.map((event) => event.sequence))
      )
        throw new Error(
          "Movement event store legacy sequence history is inconsistent; explicit reconciliation is required.",
        );
      const state: State = {
        version: 2,
        generation: randomUUID(),
        nextSequence: parsed["nextSequence"] as number,
        events: events.slice(-this.capacity),
        eventSequences: {},
        eventHashes: {},
      };
      for (const event of events) {
        state.eventSequences[event.eventId] = event.sequence;
        const { sequence: _, ...compact } = event;
        state.eventHashes[event.eventId] = digest(compact);
      }
      this.migrationNeeded = true;
      return state;
    }
    if (!validState(parsed))
      throw new Error(
        "Movement event store has an invalid schema; explicit reconciliation is required.",
      );
    if (integrityIssues(parsed).length > 0)
      throw new Error(
        "Movement event store sequence history is inconsistent; explicit reconciliation is required.",
      );
    return { ...parsed, events: parsed.events.slice(-this.capacity) };
  }
  private save(state: State = this.state) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }
  cursor(sequence: number) {
    return `${this.state.generation}:${sequence}`;
  }
  append(event: CompactMovementEvent): SequencedMovementEvent {
    const hasPrior = Object.hasOwn(this.state.eventSequences, event.eventId),
      priorSequence = hasPrior ? this.state.eventSequences[event.eventId] : undefined,
      eventHash = digest(event);
    if (priorSequence !== undefined) {
      if (this.state.eventHashes[event.eventId] !== eventHash)
        throw new Error(`Movement event ${event.eventId} was replayed with conflicting content.`);
      const prior = this.state.events.find((e) => e.sequence === priorSequence);
      return structuredClone(prior ?? { ...event, sequence: priorSequence });
    }
    const next = structuredClone(this.state);
    const record = { ...structuredClone(event), sequence: next.nextSequence++ };
    next.events.push(record);
    next.eventSequences[event.eventId] = record.sequence;
    next.eventHashes[event.eventId] = eventHash;
    if (next.events.length > this.capacity)
      next.events.splice(0, next.events.length - this.capacity);
    this.save(next);
    this.state = next;
    return structuredClone(record);
  }
  query(input: MovementCursorQuery): MovementEventPage {
    const oldest = this.state.events[0]?.sequence ?? this.state.nextSequence;
    let after = 0;
    let gap: MovementEventPage["gap"];
    if (input.cursor) {
      const split = input.cursor.lastIndexOf(":");
      const requestedGeneration = input.cursor.slice(0, split),
        sequence = Number(input.cursor.slice(split + 1));
      if (split < 1 || !Number.isSafeInteger(sequence) || sequence < 0)
        throw new Error("Movement cursor is malformed.");
      if (requestedGeneration !== this.state.generation) {
        gap = {
          code: "CURSOR_GAP",
          reason: "restart",
          oldestSequence: oldest,
          requestedGeneration,
          currentGeneration: this.state.generation,
          missingRanges: [],
          missingRangesComplete: false,
          reconciliationRequired: true,
        };
        after = oldest - 1;
      } else if (sequence < oldest - 1) {
        gap = {
          code: "CURSOR_GAP",
          reason: "expired",
          oldestSequence: oldest,
          requestedGeneration,
          currentGeneration: this.state.generation,
          missingRanges: [{ fromSequence: sequence + 1, toSequence: oldest - 1 }],
          missingRangesComplete: true,
          reconciliationRequired: true,
        };
        after = oldest - 1;
      } else after = sequence;
    }
    const limit = Math.min(500, Math.max(1, input.limit ?? 100));
    const events: SequencedMovementEvent[] = [];
    let scanned = after;
    for (const event of this.state.events) {
      if (event.sequence <= after) continue;
      scanned = event.sequence;
      const matches =
        (!input.sceneId || event.sceneId === input.sceneId) &&
        (!input.tokenId || event.tokenId === input.tokenId) &&
        (!input.userId || event.userId === input.userId) &&
        (!input.eventType || event.eventType === input.eventType) &&
        (!input.movementField || event.movementFields.includes(input.movementField)) &&
        (!input.transitionKind || event.transitions.some((t) => t.kind === input.transitionKind));
      if (matches) events.push(structuredClone(event));
      if (events.length === limit) break;
    }
    if (events.length < limit) scanned = this.state.nextSequence - 1;
    return {
      events,
      nextCursor: this.cursor(scanned),
      generation: this.state.generation,
      ...(gap ? { gap } : {}),
    };
  }
}
