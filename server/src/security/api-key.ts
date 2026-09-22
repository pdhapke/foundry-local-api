// Shared timing-safe API key comparison, used by both the REST auth
// middleware (server/src/middleware/auth.ts) and the /bridge WebSocket
// upgrade check (server/src/bridge/gateway.ts) — one static key (Phase 4,
// simplified per explicit user request: no generation/rotation/admin UI),
// checked the same way on both surfaces.
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` throws if its
 * two buffers have different lengths, which would itself leak length
 * information through a thrown-vs-not-thrown timing difference — so both
 * sides are first hashed to a fixed-length digest (SHA-256, 32 bytes),
 * which also sidesteps ever comparing raw secret bytes directly.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
