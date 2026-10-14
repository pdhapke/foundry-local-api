import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventDefinition } from "./contract.js";
import { EventService, type EventServiceOptions } from "./events.js";
import { MemoryEventStore } from "./store.js";
import type { WebhookRequest, WebhookResponse } from "./webhook.js";

const filtersSchema = z
  .object({
    tenantId: z.string(),
    streamId: z.string(),
    publisherId: z.string(),
    topicId: z.string().optional(),
  })
  .strict();
const dataSchema = filtersSchema
  .required()
  .extend({ previous: z.number().int(), next: z.number().int(), stateRevision: z.string() })
  .strict();
const inputSchema = dataSchema
  .extend({ eventId: z.string(), timestamp: z.iso.datetime({ offset: true }) })
  .strict();
const identitySchema = z.object({ userId: z.string(), lane: z.literal("publisher") }).strict();
export type FixtureFilters = z.infer<typeof filtersSchema>;
export type FixtureData = z.infer<typeof dataSchema>;
export type FixtureInput = z.infer<typeof inputSchema>;
export type FixtureIdentity = z.infer<typeof identitySchema>;
export function fixtureEventId(data: FixtureData): string {
  return `event-${createHash("sha256")
    .update(
      JSON.stringify([
        data.tenantId,
        data.streamId,
        data.publisherId,
        data.topicId,
        data.previous,
        data.next,
        data.stateRevision,
      ]),
    )
    .digest("hex")}`;
}
export const fixtureDefinition: EventDefinition<
  FixtureFilters,
  FixtureData,
  FixtureInput,
  FixtureIdentity
> = {
  name: "fixture.record_updated",
  description: "A synthetic record changed.",
  filtersSchema,
  dataSchema,
  inputSchema,
  identitySchema,
  eventId: fixtureEventId,
  data: (input) => {
    const { eventId: _id, timestamp: _time, ...data } = input;
    return data;
  },
  canonicalFilters: (f) =>
    JSON.stringify([f.tenantId, f.streamId, f.publisherId, f.topicId ?? null]),
  matchesFilters: (d, f) =>
    d.tenantId === f.tenantId &&
    d.streamId === f.streamId &&
    d.publisherId === f.publisherId &&
    (!f.topicId || d.topicId === f.topicId),
  sameScope: (a, b) =>
    a.tenantId === b.tenantId &&
    a.streamId === b.streamId &&
    a.publisherId === b.publisherId &&
    (!b.topicId || a.topicId === b.topicId),
  validateOccurrence: (i, now) =>
    i.next === i.previous + 1 &&
    Date.parse(i.timestamp) <= now + 30000 &&
    Date.parse(i.timestamp) >= now - 120000,
};
export type FixtureOptions = EventServiceOptions<
  FixtureFilters,
  FixtureData,
  FixtureInput,
  FixtureIdentity
>;
export const FIXTURE_NOW = Date.parse("2026-10-09T12:00:00Z");
export const fixtureSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
export const fixtureOwner = "fixture-principal";
export const fixtureFilters: FixtureFilters = {
  tenantId: "tenant-one",
  streamId: "stream-one",
  publisherId: "publisher-one",
};
export const fixtureIdentity: FixtureIdentity = { userId: "user-one", lane: "publisher" };
export function fixtureEvent(revision = 1): FixtureInput {
  const data = {
    ...fixtureFilters,
    topicId: "topic-one",
    previous: revision - 1,
    next: revision,
    stateRevision: `revision-${revision}`,
  };
  return { ...data, eventId: fixtureEventId(data), timestamp: new Date(FIXTURE_NOW).toISOString() };
}
export function fixtureSubscription(overrides: Record<string, unknown> = {}) {
  return {
    name: fixtureDefinition.name,
    arguments: fixtureFilters,
    delivery: {
      mode: "webhook",
      url: "https://callback.example.com/fixture",
      secret: fixtureSecret,
    },
    ...overrides,
  };
}
export function fixtureService(overrides: Partial<FixtureOptions> = {}) {
  let now = FIXTURE_NOW;
  let authorized = true;
  let response: WebhookResponse = { status: 204, body: "" };
  const requests: WebhookRequest[] = [];
  const store = new MemoryEventStore(fixtureDefinition);
  const options: FixtureOptions = {
    definition: fixtureDefinition,
    store,
    now: () => now,
    codec: {
      seal: (secret) => Buffer.from(`inert-fixture:${secret}`).toString("base64"),
      unseal: (encoded) =>
        Buffer.from(encoded, "base64").toString("utf8").slice("inert-fixture:".length),
    },
    authorizeSubscription: (owner, f) =>
      authorized && owner === fixtureOwner && fixtureDefinition.sameScope(f, fixtureFilters),
    authorizeIngress: (i, v) =>
      authorized && i.tenantId === fixtureFilters.tenantId && v.userId === fixtureIdentity.userId,
    canDeliver: () => authorized,
    webhooks: {
      verify: async () => {},
      send: async (input) => {
        requests.push(input);
        return response;
      },
    },
    ...overrides,
  };
  return {
    service: new EventService(options),
    options,
    store,
    requests,
    setNow(value: number) {
      now = value;
    },
    setAuthorized(value: boolean) {
      authorized = value;
    },
    setResponse(value: WebhookResponse) {
      response = value;
    },
  };
}
