// Unit test for Phase 26's SSE route handler, extracted from Express route
// wiring (events-sse.ts exports `eventsSseHandler` standalone for exactly
// this reason) so it's testable directly against fake req/res objects
// rather than a real HTTP connection.
//
// A genuinely open SSE response never resolves a normal supertest request —
// supertest waits for the response to end, which this route deliberately
// never does on its own — so per PLAN.md's testing guidance this narrows to
// a direct handler unit test (headers/frame-format/unsubscribe-on-close/
// no-event-bus-503) instead of an end-to-end streaming assertion. The route
// is mounted with a single `apiRouter.get("/events", eventsSseHandler)`
// call in server/src/routes/api.ts, reviewed directly rather than exercised
// by a live request here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Request, Response } from "express";

import { FoundryEventBus } from "../events/event-bus.js";
import { eventsSseHandler } from "./events-sse.js";

function buildFakeReqRes(eventBus?: FoundryEventBus) {
  const closeListeners: Array<() => void> = [];
  const writes: string[] = [];
  let headWritten: { status: number; headers: Record<string, string> } | undefined;
  let flushed = false;
  let ended = false;
  let jsonBody: unknown;
  let statusCode: number | undefined;

  const req = {
    app: { locals: { eventBus } },
    on: (event: string, cb: () => void) => {
      if (event === "close") {
        closeListeners.push(cb);
      }
      return req;
    },
  } as unknown as Request;

  const res: Response = {
    writeHead: (status: number, headers: Record<string, string>) => {
      headWritten = { status, headers };
      return res;
    },
    flushHeaders: () => {
      flushed = true;
    },
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
      return res;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      jsonBody = body;
      return res;
    },
  } as unknown as Response;

  return {
    req,
    res,
    writes,
    triggerClose: () => {
      for (const cb of closeListeners) {
        cb();
      }
    },
    get headWritten() {
      return headWritten;
    },
    get flushed() {
      return flushed;
    },
    get ended() {
      return ended;
    },
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
  };
}

void describe("eventsSseHandler", () => {
  void it("sets SSE headers and writes each published event as an SSE frame", () => {
    const eventBus = new FoundryEventBus();
    const harness = buildFakeReqRes(eventBus);

    eventsSseHandler(harness.req, harness.res, () => {
      /* next() not expected to be called on the happy path */
    });

    assert.equal(harness.headWritten?.status, 200);
    assert.equal(harness.headWritten?.headers["Content-Type"], "text/event-stream");
    assert.ok(harness.flushed);

    eventBus.publish("createActor", { _id: "a1" });

    assert.equal(harness.writes.length, 1);
    assert.equal(
      harness.writes[0],
      `event: createActor\ndata: ${JSON.stringify({ _id: "a1" })}\n\n`,
    );
  });

  void it("unsubscribes from the event bus and ends the response when the request closes", () => {
    const eventBus = new FoundryEventBus();
    const harness = buildFakeReqRes(eventBus);

    eventsSseHandler(harness.req, harness.res, () => {
      /* noop */
    });
    harness.triggerClose();

    assert.ok(harness.ended);

    eventBus.publish("createActor", {});
    assert.equal(harness.writes.length, 0, "no write should happen after unsubscribe");
  });

  void it("responds 503 with a JSON error body when no event bus is wired up, without starting the stream", () => {
    const harness = buildFakeReqRes(undefined);

    eventsSseHandler(harness.req, harness.res, () => {
      /* noop */
    });

    assert.equal(harness.statusCode, 503);
    assert.equal((harness.jsonBody as { error: { code: string } }).error.code, "NO_EVENT_BUS");
    assert.equal(harness.headWritten, undefined, "must not start the SSE stream on the error path");
  });
});
