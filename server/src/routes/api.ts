// The `/api` mount point (Phase 4). Deliberately empty — no `/api/*` REST
// endpoints exist yet (that starts Phase 6) — this just gives the
// auth/CORS/rate-limit middleware stack in app.ts somewhere real to attach,
// so Phase 6 can add routes to `apiRouter` without touching app.ts again.
import { Router } from "express";

export const apiRouter: Router = Router();
