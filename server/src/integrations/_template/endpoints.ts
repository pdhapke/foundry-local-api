// TEMPLATE — copy this whole directory to server/src/integrations/<your-id>/
// and work through README.md's checklist. This file is never imported by
// server/src/integrations/registry.ts and module.json never references it —
// it exists purely as a copy-paste starting point, proven against the real
// dnd5e integration (Phases 34-35) this structure was extracted from.
import { z } from "zod";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "../../endpoints/types.js";

// TODO: once you've copied this directory, delete everything below this line
// down to `templateEndpointDescriptors` and instead import your real
// `<YOUR_ID>_COMMANDS` + input/result types from `@foundry-local-api/shared`
// (put those in a new shared/src/<your-id>.ts — see shared/src/dnd5e.ts for
// the pattern, and README.md step 2). This local placeholder only exists so
// this file typechecks standalone as a template.
const TEMPLATE_COMMANDS = {
  EXAMPLE: "templateExample",
} as const;

interface TemplateExampleInput {
  id: string;
}

interface TemplateExampleResult {
  id: string;
  message: string;
}

// TODO: one descriptor per REST route + MCP tool your integration exposes.
// `path` MUST start with `/<your-id>` (the dynamic integration router,
// server/src/integrations/router.ts, mounts every active integration under
// /api/integrations, and 404s an inactive integration's own `/<id>/*`
// namespace by convention) — this template deliberately uses `/_template`
// so it's self-consistent even though it's never actually mounted anywhere.
// MCP tool `name` must use the integration's effective prefix: `<your-id>_`
// by default, or the explicit `toolPrefix` from index.ts when package
// identity and the portable MCP namespace differ.
const exampleDescriptor: EndpointDescriptor<TemplateExampleInput, TemplateExampleResult> = {
  name: "template_example",
  description: "TODO: describe what this endpoint does and when a caller would use it.",
  method: "get",
  path: "/_template/example/:id",
  inputSchema: z.object({ id: z.string().min(1) }),
  handler: (input, { foundryClient }) =>
    foundryClient.call<TemplateExampleInput, TemplateExampleResult>(
      TEMPLATE_COMMANDS.EXAMPLE,
      input,
    ),
};

export const templateEndpointDescriptors: AnyEndpointDescriptor[] = [exampleDescriptor];
