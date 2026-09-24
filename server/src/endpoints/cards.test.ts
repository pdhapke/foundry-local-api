// Integration test for Phase 18 — RollTables & Cards (Cards half), built on
// the Phase 16/17 template (see combats.test.ts's header comment): a real
// Express app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the
// card-pile extras (draw/shuffle/reset) plus a smoke check that
// cardsEndpointDescriptors actually mounts CRUD under `/api/cards`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  CardsDealInput,
  CardsDrawInput,
  CardsIdInput,
  CardsPassInput,
  DocumentData,
  DocumentTypeInput,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { API_KEY_HEADER } from "../middleware/auth.js";

const API_KEY = "test-api-key-0123456789abcdef";

function buildApp(call: FoundryClient["call"]) {
  const app = createApp({
    isDevelopment: false,
    apiKey: API_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1000,
    requestLogger: () => {
      /* silence request logging in tests */
    },
  });
  const fakeFoundryClient = { call } as unknown as FoundryClient;
  app.locals["foundryClient"] = fakeFoundryClient;
  return app;
}

void describe("Phase 18 cards", () => {
  void it("GET /api/cards lists documents via the generic Cards CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Cards" });
      const result: DocumentData[] = [{ _id: "deck1", name: "Deck of Many Things" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/cards").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "deck1", name: "Deck of Many Things" }]);
  });

  void it("POST /api/cards/:id/draw draws the given number of cards from sourceId", async () => {
    const app = buildApp(((type: string, payload: CardsDrawInput) => {
      assert.equal(type, "cardsDraw");
      assert.deepEqual(payload, { id: "hand1", sourceId: "deck1", number: 2 });
      const result: DocumentData[] = [
        { _id: "card1", name: "Ace of Spades" },
        { _id: "card2", name: "King of Hearts" },
      ];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/cards/hand1/draw")
      .set(API_KEY_HEADER, API_KEY)
      .send({ sourceId: "deck1", number: 2 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      { _id: "card1", name: "Ace of Spades" },
      { _id: "card2", name: "King of Hearts" },
    ]);
  });

  void it("POST /api/cards/:id/draw defaults number to 1 when omitted", async () => {
    const app = buildApp(((type: string, payload: CardsDrawInput) => {
      assert.equal(type, "cardsDraw");
      assert.deepEqual(payload, { id: "hand1", sourceId: "deck1" });
      const result: DocumentData[] = [{ _id: "card1", name: "Ace of Spades" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/cards/hand1/draw")
      .set(API_KEY_HEADER, API_KEY)
      .send({ sourceId: "deck1" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "card1", name: "Ace of Spades" }]);
  });

  void it("POST /api/cards/:id/shuffle shuffles the stack", async () => {
    const app = buildApp(((type: string, payload: CardsIdInput) => {
      assert.equal(type, "cardsShuffle");
      assert.deepEqual(payload, { id: "deck1" });
      const result: DocumentData = { _id: "deck1", name: "Deck of Many Things" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/cards/deck1/shuffle").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "deck1", name: "Deck of Many Things" });
  });

  void it("POST /api/cards/:id/reset resets the stack", async () => {
    const app = buildApp(((type: string, payload: CardsIdInput) => {
      assert.equal(type, "cardsReset");
      assert.deepEqual(payload, { id: "deck1" });
      const result: DocumentData = { _id: "deck1", name: "Deck of Many Things" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/cards/deck1/reset").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "deck1", name: "Deck of Many Things" });
  });

  void it("POST /api/cards/:id/pass moves the given card ids to another stack", async () => {
    const app = buildApp(((type: string, payload: CardsPassInput) => {
      assert.equal(type, "cardsPass");
      assert.deepEqual(payload, { id: "deck1", toId: "hand1", cardIds: ["card1", "card2"] });
      const result: DocumentData[] = [
        { _id: "card1", name: "Ace of Spades" },
        { _id: "card2", name: "King of Hearts" },
      ];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/cards/deck1/pass")
      .set(API_KEY_HEADER, API_KEY)
      .send({ toId: "hand1", cardIds: ["card1", "card2"] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      { _id: "card1", name: "Ace of Spades" },
      { _id: "card2", name: "King of Hearts" },
    ]);
  });

  void it("POST /api/cards/:id/deal distributes cards to multiple destinations", async () => {
    const app = buildApp(((type: string, payload: CardsDealInput) => {
      assert.equal(type, "cardsDeal");
      assert.deepEqual(payload, { id: "deck1", toIds: ["hand1", "hand2"], number: 2 });
      const result: DocumentData = { _id: "deck1", name: "Deck of Many Things" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/cards/deck1/deal")
      .set(API_KEY_HEADER, API_KEY)
      .send({ toIds: ["hand1", "hand2"], number: 2 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "deck1", name: "Deck of Many Things" });
  });

  void it("POST /api/cards/:id/deal defaults number to 1 when omitted", async () => {
    const app = buildApp(((type: string, payload: CardsDealInput) => {
      assert.equal(type, "cardsDeal");
      assert.deepEqual(payload, { id: "deck1", toIds: ["hand1", "hand2"] });
      const result: DocumentData = { _id: "deck1", name: "Deck of Many Things" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/cards/deck1/deal")
      .set(API_KEY_HEADER, API_KEY)
      .send({ toIds: ["hand1", "hand2"] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "deck1", name: "Deck of Many Things" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/cards/deck1/shuffle");
    assert.equal(res.status, 401);
  });
});
