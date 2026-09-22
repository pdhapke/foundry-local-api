// Phase 32 — the dynamic REST piece: mounted once at `/api/integrations`
// (server/src/routes/api.ts) but rebuildable at runtime as the active
// integration set changes (world reload, GM enabling/disabling a module) —
// never requires a server restart.
//
// Rebuild-not-mutate strategy: Express routers have no API to remove a
// previously-registered route, so "unmounting" an integration can't be done
// by mutating a long-lived router in place. Instead, `applyActiveIntegrations`
// builds a brand new `express.Router()` from scratch every time it's called
// and swaps a module-level `currentRouter` pointer to it.
// `integrationRouterMiddleware` is a thin indirection — `(req, res, next) =>
// currentRouter(req, res, next)` — so `routes/api.ts` can mount it exactly
// once and have every request transparently pick up whichever router
// `currentRouter` currently points to. That indirection is the actual
// "unmount without restarting Express" trick.
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";

import { mountRestEndpoints } from "../endpoints/registry.js";
import { integrations as registeredIntegrations } from "./registry.js";
import type { Integration } from "./types.js";

let currentRouter: Router;

/**
 * Rebuilds the dynamic integration router from scratch.
 *
 * `allRegistered` defaults to the real registry (./registry.js) so
 * production call sites (server/src/index.ts) never need to pass it, but
 * tests can pass their own small fake lists for both `active` and
 * `allRegistered` — this function takes the full integration list as an
 * explicit parameter rather than importing `./registry.js` internally *for
 * that reason*, so the module stays pure/testable without monkeypatching a
 * module-level singleton export.
 *
 * Walks every *registered* integration (not just the active ones) because
 * an inactive-but-registered integration still needs its namespace mounted
 * — as a 404 naming the missing dependency, not silently falling through to
 * this router's own catch-all.
 */
export function applyActiveIntegrations(
  active: Integration[],
  allRegistered: Integration[] = registeredIntegrations,
): void {
  const router: Router = express.Router();
  const activeIds = new Set(active.map((i) => i.id));

  for (const integration of allRegistered) {
    if (activeIds.has(integration.id)) {
      mountRestEndpoints(router, integration.endpoints);
      continue;
    }

    const notActive: RequestHandler = (_req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: `Integration '${integration.id}' is not active in this world (requires ${integration.kind} '${integration.id}' to be active)`,
          code: "INTEGRATION_INACTIVE",
        },
      });
    };

    // Express 5 (path-to-regexp v8) gotcha: a bare trailing `/*` wildcard
    // segment throws/behaves differently under path-to-regexp v8 — it needs
    // a *named* wildcard segment instead (`/*splat`). The bare
    // `/${id}` route (no trailing segment at all) is handled separately
    // since a wildcard segment doesn't match zero segments.
    router.all(`/${integration.id}`, notActive);
    router.all(`/${integration.id}/*splat`, notActive);
  }

  currentRouter = router;
}

/**
 * Mounted once by server/src/routes/api.ts at `/api/integrations`. Delegates
 * to whatever `currentRouter` currently points to on each request — see this
 * file's header comment for why this indirection exists.
 */
export const integrationRouterMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  currentRouter(req, res, next);
};

// Build a valid (empty, all-inactive) router at module load time, so
// `currentRouter` is never used before being assigned, before the first real
// `refresh()`-driven call ever happens.
applyActiveIntegrations([]);
