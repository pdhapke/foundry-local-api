// Phase 26 — Hooks/Event Streaming: the REST half, `GET /api/events`.
//
// Doesn't fit the EndpointDescriptor pattern (registry.ts's `mountRestEndpoints`
// calls a handler once and `res.json()`s the result) — SSE needs to hold the
// connection open and `res.write()` repeatedly, so this is hand-rolled and
// mounted directly in server/src/routes/api.ts, the same "descriptor pattern
// doesn't fit, hand-roll instead" precedent as `/health` (predates the
// pattern entirely — see types.ts) and Phase 20's compendium-pack routing.
// Still runs behind the `/api` mount's CORS/rate-limit/auth chain
// (server/src/app.ts) since it's registered on the same `apiRouter`.
//
// Caveat: Express's rate limiter counts this connection once at open, and
// its request timeout/keep-alive behavior around a deliberately long-lived
// response is untested here beyond what `app.ts` already configures — no
// attempt was made to add SSE-specific timeout tuning.
import type { Request, RequestHandler, Response } from "express";

import type { FoundryEventBus } from "../events/event-bus.js";

/** Extracted from route wiring so it's directly unit-testable without a real HTTP server (see events-sse.test.ts). */
export const eventsSseHandler: RequestHandler = (req: Request, res: Response) => {
  const eventBus = req.app.locals["eventBus"] as FoundryEventBus | undefined;
  if (!eventBus) {
    res.status(503).json({
      error: { message: "No event bus is currently wired up on this server.", code: "NO_EVENT_BUS" },
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const unsubscribe = eventBus.subscribe((event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
};
