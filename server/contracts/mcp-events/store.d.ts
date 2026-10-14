import type { z } from "zod";
import { type EventDefinition, type EventInput } from "./contract.js";
type DeliverySchema = z.ZodObject<
  {
    subscriptionId: z.ZodString;
    eventId: z.ZodString;
    sequence: z.ZodNumber;
    status: z.ZodEnum<{
      queued: "queued";
      in_flight: "in_flight";
      received: "received";
      dead_letter: "dead_letter";
      cancelled: "cancelled";
    }>;
    attempts: z.ZodNumber;
    nextAttemptAt: z.ZodNumber;
    leaseUntil: z.ZodOptional<z.ZodNumber>;
    lastReason: z.ZodOptional<z.ZodString>;
  },
  z.core.$strict
>;
export declare function eventStoreSchema<F, I extends EventInput>(
  filtersSchema: z.ZodType<F>,
  inputSchema: z.ZodType<I>,
): z.ZodObject<
  {
    version: z.ZodLiteral<1>;
    generation: z.ZodString;
    nextSequence: z.ZodNumber;
    events: z.ZodArray<
      z.ZodObject<
        {
          sequence: z.ZodNumber;
          input: z.ZodType<I, unknown, z.core.$ZodTypeInternals<I, unknown>>;
        },
        z.core.$strict
      >
    >;
    subscriptions: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          owner: z.ZodString;
          filters: z.ZodType<F, unknown, z.core.$ZodTypeInternals<F, unknown>>;
          callbackUrl: z.ZodString;
          sealedSecret: z.ZodString;
          previousSealedSecret: z.ZodOptional<z.ZodString>;
          rotationUntil: z.ZodOptional<z.ZodNumber>;
          expiresAt: z.ZodNumber;
          status: z.ZodEnum<{
            active: "active";
            stopped: "stopped";
          }>;
          revision: z.ZodNumber;
          watermark: z.ZodNumber;
        },
        z.core.$strict
      >
    >;
    deliveries: z.ZodArray<
      z.ZodObject<
        {
          subscriptionId: z.ZodString;
          eventId: z.ZodString;
          sequence: z.ZodNumber;
          status: z.ZodEnum<{
            queued: "queued";
            in_flight: "in_flight";
            received: "received";
            dead_letter: "dead_letter";
            cancelled: "cancelled";
          }>;
          attempts: z.ZodNumber;
          nextAttemptAt: z.ZodNumber;
          leaseUntil: z.ZodOptional<z.ZodNumber>;
          lastReason: z.ZodOptional<z.ZodString>;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
>;
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
export type EventDelivery = z.infer<DeliverySchema>;
export interface EventStoreState<F, I extends EventInput> {
  version: 1;
  generation: string;
  nextSequence: number;
  events: Array<{
    sequence: number;
    input: I;
  }>;
  subscriptions: Array<EventSubscription<F>>;
  deliveries: EventDelivery[];
}
export interface EventStore<F, I extends EventInput> {
  read(): EventStoreState<F, I>;
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T;
}
export declare function initialEventStore<F, I extends EventInput>(): EventStoreState<F, I>;
/** Synthetic tests only; production must supply persistent private storage. */
export declare class MemoryEventStore<F, D, I extends EventInput, V> implements EventStore<F, I> {
  #private;
  readonly definition: EventDefinition<F, D, I, V>;
  constructor(definition: EventDefinition<F, D, I, V>, state?: EventStoreState<F, I>);
  read(): EventStoreState<F, I>;
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T;
}
/** Single-runtime writer; pending-file lock and source digest reject competing writers.
 * Private Windows ACL/encrypted secret codec checks are supplied by reviewed wiring.
 * No directory is created and no old pending/lock file is removed automatically.
 */
export declare class FileEventStore<F, D, I extends EventInput, V> implements EventStore<F, I> {
  #private;
  readonly assertPrivateStorage: (path: string) => void;
  readonly definition: EventDefinition<F, D, I, V>;
  constructor(
    path: string,
    assertPrivateStorage: (path: string) => void,
    definition: EventDefinition<F, D, I, V>,
  );
  private checkPath;
  read(): EventStoreState<F, I>;
  transact<T>(operation: (state: EventStoreState<F, I>) => T): T;
}
export {};
