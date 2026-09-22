// The `/api` mount point (Phase 4, populated starting Phase 6). Every
// descriptor in `allEndpointDescriptors` that supplies `method`+`path` gets
// a real route here — see server/src/endpoints/registry.ts.
import { Router } from "express";

import { allEndpointDescriptors } from "../endpoints/index.js";
import { mountRestEndpoints } from "../endpoints/registry.js";

export const apiRouter: Router = Router();
mountRestEndpoints(apiRouter, allEndpointDescriptors);
