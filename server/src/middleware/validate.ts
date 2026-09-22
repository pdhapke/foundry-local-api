// Reusable zod-based validation middleware factory (Phase 4). No real route
// uses this yet — Phase 6 is the first — but the pattern is established here
// so every route handler from then on validates input the same way.
import type { NextFunction, Request, Response } from "express";
import type { ZodType, ZodError } from "zod";

import { HttpError } from "../app.js";

function describeZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(body)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Validates `req.body` against `schema`. On success, the parsed (and
 * possibly coerced/defaulted) value is written to `req.body` and also
 * exposed as `res.locals["validatedBody"]` for handlers that prefer not to
 * rely on the mutated `req.body`. On failure, 400s via `HttpError` — never
 * a raw `res.status()` call — through the centralized error handler.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new HttpError(400, describeZodError(result.error), "VALIDATION_ERROR"));
      return;
    }
    req.body = result.data;
    res.locals["validatedBody"] = result.data;
    next();
  };
}

/**
 * Validates `req.query` against `schema`. Express 5's `req.query` is a
 * read-only getter (no setter), so — unlike `validateBody` — the parsed
 * result is only exposed via `res.locals["validatedQuery"]`; handlers read
 * from there rather than from a mutated `req.query`.
 */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new HttpError(400, describeZodError(result.error), "VALIDATION_ERROR"));
      return;
    }
    res.locals["validatedQuery"] = result.data;
    next();
  };
}
