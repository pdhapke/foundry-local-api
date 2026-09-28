import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validState(value: unknown): value is State {
  if (
    !isRecord(value) ||
    value["version"] !== 2 ||
    typeof value["generation"] !== "string" ||
    !Number.isSafeInteger(value["nextSequence"]) ||
    !Array.isArray(value["events"]) ||
    !isRecord(value["eventSequences"]) ||
    !isRecord(value["eventHashes"])
  )
    return false;
  const events = value["events"] as unknown[];
  return (
    events.every(
      (e) =>
        isRecord(e) &&
        typeof e["eventId"] === "string" &&
        e["eventType"] === "token_movement" &&
        typeof e["sceneId"] === "string" &&
        typeof e["tokenId"] === "string" &&
        typeof e["userId"] === "string" &&
        Array.isArray(e["movementFields"]) &&
        Array.isArray(e["waypoints"]) &&
        Array.isArray(e["segments"]) &&
        Array.isArray(e["transitions"]) &&
        Number.isSafeInteger(e["sequence"]),
    ) &&
    Object.values(value["eventSequences"]).every(Number.isSafeInteger) &&
    Object.values(value["eventHashes"]).every((v) => typeof v === "string")
  );
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
  private load(): State {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
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
    const sequences = parsed.events.map((e) => e.sequence);
    if (
      sequences.some((n, i) => i > 0 && n <= sequences[i - 1]!) ||
      parsed.nextSequence <= Math.max(0, ...sequences) ||
      parsed.events.some((event) => {
        const { sequence, ...compact } = event;
        return (
          parsed.eventSequences[event.eventId] !== sequence ||
          parsed.eventHashes[event.eventId] !== digest(compact)
        );
      })
    )
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
