// The `/api` mount point (Phase 4, populated starting Phase 6). Every
// descriptor in `allEndpointDescriptors` that supplies `method`+`path` gets
// a real route here — see server/src/endpoints/registry.ts.
import { Router } from "express";

import { eventsSseHandler } from "../endpoints/events-sse.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import { mountRestEndpoints } from "../endpoints/registry.js";

export const apiRouter: Router = Router();
mountRestEndpoints(apiRouter, allEndpointDescriptors);

// Hand-rolled (Phase 26) — see events-sse.ts's header comment for why this
// doesn't go through mountRestEndpoints()/the descriptor pattern.
apiRouter.get("/events", eventsSseHandler);
