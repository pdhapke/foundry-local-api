import { z } from "zod";

import {
  TRAILS_COMMANDS,
  type TrailsActionRollInput,
  type TrailsActionRollResult,
  type TrailsActorIdInput,
  type TrailsActorInventoryResult,
  type TrailsActorSheetResult,
  type TrailsBuilderPreviewInput,
  type TrailsBuilderPreviewResult,
  type TrailsCatalogInput,
  type TrailsCatalogListResult,
  type TrailsCatalogResult,
  type TrailsConfigResult,
  type TrailsCreationReadinessResult,
  type TrailsDamagePreviewInput,
  type TrailsDamagePreviewResult,
  type TrailsExperienceProgressInput,
  type TrailsExperienceProgressResult,
  type TrailsInitiativeInput,
  type TrailsInitiativeResult,
  type TrailsRecoveryPreviewInput,
  type TrailsRecoveryPreviewResult,
  type TrailsThreatContestInput,
  type TrailsThreatContestResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "../../endpoints/types.js";

const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 500;
const MAX_DOMAIN_INTEGER = 1_000_000;
const MAX_ROLL_POOL = 100;
const MAX_PARTICIPANTS = 100;
const MAX_CITATION_VALUES = 100;
const MAX_BUILDER_BYTES = 2_000_000;

const id = z.string().trim().min(1).max(MAX_ID_LENGTH);
const boundedText = z.string().max(MAX_LABEL_LENGTH);
const poolCount = z.number().int().min(0).max(MAX_ROLL_POOL);
const domainInteger = z.number().int().min(0).max(MAX_DOMAIN_INTEGER);

const sourceCitationSchema = z.object({
  chapter: domainInteger.optional(),
  printedPage: domainInteger.optional(),
  printedPages: z.array(domainInteger).max(MAX_CITATION_VALUES).optional(),
  pdfPage: domainInteger.optional(),
  section: boundedText.optional(),
  sections: z.array(boundedText).max(MAX_CITATION_VALUES).optional(),
  entry: boundedText.optional(),
  bookHash: boundedText.optional(),
});

const actorIdSchema: z.ZodType<TrailsActorIdInput> = z.object({ id });
const catalogSchema: z.ZodType<TrailsCatalogInput> = z.object({
  packId: z.enum([
    "trails-of-destiny.character-options",
    "trails-of-destiny.social",
    "trails-of-destiny.crafts-arts",
    "trails-of-destiny.equipment-orbment",
  ]),
});

const conditionalDieSchema = z.object({
  id,
  label: boundedText,
  selected: z.boolean(),
  dice: poolCount,
  source: sourceCitationSchema.nullable(),
});

const actionRollSchema: z.ZodType<TrailsActionRollInput> = z
  .object({
    kind: z.enum(["action", "skill"]),
    abilityId: z.string().max(MAX_ID_LENGTH),
    skillId: z.string().max(MAX_ID_LENGTH),
    abilityDice: poolCount,
    skillDice: poolCount,
    otherDice: poolCount,
    abilityChallenges: z.number().int().min(0).max(1),
    challenges: poolCount,
    chances: z.number().int().min(0).max(3),
    charges: poolCount,
    vs: z.number().int().min(0).max(10_000).nullable().optional(),
    conditionalDice: z.array(conditionalDieSchema).max(MAX_ROLL_POOL),
  })
  .superRefine((value, ctx) => {
    const conditional = value.conditionalDice
      .filter((entry) => entry.selected)
      .reduce((sum, entry) => sum + entry.dice, 0);
    if (value.abilityDice + value.skillDice + value.otherDice + conditional > MAX_ROLL_POOL) {
      ctx.addIssue({
        code: "custom",
        message: `Total selected Bonus Dice cannot exceed ${MAX_ROLL_POOL}.`,
        path: ["conditionalDice"],
      });
    }
    if (value.abilityChallenges + value.challenges > MAX_ROLL_POOL) {
      ctx.addIssue({
        code: "custom",
        message: `Total Challenges cannot exceed ${MAX_ROLL_POOL}.`,
        path: ["challenges"],
      });
    }
    if (value.charges + value.chances > MAX_ROLL_POOL) {
      ctx.addIssue({
        code: "custom",
        message: `Total Charges cannot exceed ${MAX_ROLL_POOL}.`,
        path: ["charges"],
      });
    }
  });

const initiativeParticipantSchema = z.object({
  id,
  label: boundedText.optional(),
  bonusDice: poolCount,
  challenges: poolCount,
  charges: poolCount,
  chances: z.literal(0).optional(),
  sources: z.array(sourceCitationSchema).max(MAX_CITATION_VALUES),
});

const initiativeSchema: z.ZodType<TrailsInitiativeInput> = z
  .object({ participants: z.array(initiativeParticipantSchema).max(MAX_PARTICIPANTS) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.participants.forEach((participant, index) => {
      if (seen.has(participant.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate initiative participant '${participant.id}'.`,
          path: ["participants", index, "id"],
        });
      }
      seen.add(participant.id);
    });
  });

const threatContestSchema: z.ZodType<TrailsThreatContestInput> = z.object({
  classification: z.enum(["attack", "assault"]),
  actionTotal: domainInteger,
  passiveDefense: domainInteger,
  reactionTotal: domainInteger.nullable().optional(),
});

const damageSchema: z.ZodType<TrailsDamagePreviewInput> = z.object({
  durability: domainInteger,
  health: domainInteger,
  damage: domainInteger,
  lifeState: z.enum(["active", "shock", "dead"]).optional(),
});

const resourceSchema = z.object({ value: domainInteger, max: domainInteger });
const recoveryResourceSchema = z.object({
  durability: resourceSchema,
  health: resourceSchema,
  vigor: resourceSchema,
  mana: resourceSchema,
  energy: resourceSchema,
});
const recoveryEligibilitySchema = z.object({
  durability: z.boolean(),
  health: z.boolean(),
  vigor: z.boolean(),
  mana: z.boolean(),
  energy: z.boolean(),
});
const recordedD10Schema = z.array(z.number().int().min(1).max(10)).max(MAX_ROLL_POOL);

const recoverySchema: z.ZodType<TrailsRecoveryPreviewInput> = z
  .object({
    kind: z.enum(["break", "sleep"]),
    resources: recoveryResourceSchema,
    stamina: domainInteger.optional(),
    staminaBonusDice: poolCount.optional(),
    soulBonusDice: poolCount.optional(),
    staminaDice: recordedD10Schema.nullable().optional(),
    soulDice: recordedD10Schema.nullable().optional(),
    eligibility: recoveryEligibilitySchema,
  })
  .superRefine((value, ctx) => {
    const staminaBonusDice = value.staminaBonusDice ?? 0;
    const soulBonusDice = value.soulBonusDice ?? 0;
    if (value.staminaDice !== undefined && value.staminaDice !== null) {
      if (value.staminaDice.length !== staminaBonusDice) {
        ctx.addIssue({
          code: "custom",
          message: "staminaDice must contain exactly staminaBonusDice recorded d10 results.",
          path: ["staminaDice"],
        });
      }
    }
    if (value.soulDice !== undefined && value.soulDice !== null) {
      if (value.soulDice.length !== soulBonusDice) {
        ctx.addIssue({
          code: "custom",
          message: "soulDice must contain exactly soulBonusDice recorded d10 results.",
          path: ["soulDice"],
        });
      }
      if (value.kind === "break") {
        ctx.addIssue({
          code: "custom",
          message: "A Break cannot include Soul dice.",
          path: ["soulDice"],
        });
      }
    }
  });

const experienceSchema: z.ZodType<TrailsExperienceProgressInput> = z.object({
  // REST path parameters arrive as strings; MCP callers may supply a number.
  totalExperience: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const builderSchema: z.ZodType<TrailsBuilderPreviewInput> = z.object({
  raw: z
    .string()
    // Retain an ordinary max constraint for generated JSON Schema clients;
    // the refinement below is the authoritative UTF-8 byte check.
    .max(MAX_BUILDER_BYTES)
    .superRefine((value, ctx) => {
      // Express' `2mb` JSON limit is measured in request bytes, not UTF-16
      // code units. Keep this descriptor-level bound byte-accurate as well so
      // MCP and REST callers receive the same limit for multibyte JSON text.
      if (Buffer.byteLength(value, "utf8") > MAX_BUILDER_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `Builder JSON must not exceed ${MAX_BUILDER_BYTES} UTF-8 bytes.`,
        });
      }
    }),
});

const deterministicReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const randomPreviewAnnotations = {
  ...deterministicReadAnnotations,
  idempotentHint: false,
} as const;

const getConfigDescriptor: EndpointDescriptor<void, TrailsConfigResult> = {
  name: "trails_get_config",
  description:
    "Reads safe Trails package, rules, gameplay, catalog, and capability metadata. It does not change Foundry or Trails state.",
  method: "get",
  path: "/trails-of-destiny/config",
  annotations: deterministicReadAnnotations,
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, TrailsConfigResult>(TRAILS_COMMANDS.CONFIG),
};

const getActorSheetDescriptor: EndpointDescriptor<TrailsActorIdInput, TrailsActorSheetResult> = {
  name: "trails_get_actor_sheet",
  description:
    "Reads an authorized, redacted prepared Trails actor summary and readiness findings. It omits private narrative and retained creation evidence and does not update the Actor.",
  method: "get",
  path: "/trails-of-destiny/actors/:id/sheet",
  inputSchema: actorIdSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsActorIdInput, TrailsActorSheetResult>(
      TRAILS_COMMANDS.ACTOR_SHEET,
      input,
    ),
};

const getActorInventoryDescriptor: EndpointDescriptor<
  TrailsActorIdInput,
  TrailsActorInventoryResult
> = {
  name: "trails_get_actor_inventory",
  description:
    "Reads all authorized embedded Trails items without deduplicating catalog IDs, preserving document, catalog, and owned-instance identities. It does not update inventory.",
  method: "get",
  path: "/trails-of-destiny/actors/:id/inventory",
  inputSchema: actorIdSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsActorIdInput, TrailsActorInventoryResult>(
      TRAILS_COMMANDS.ACTOR_INVENTORY,
      input,
    ),
};

const listCatalogsDescriptor: EndpointDescriptor<void, TrailsCatalogListResult> = {
  name: "trails_list_catalogs",
  description:
    "Lists the four known Trails catalogs with access status and safe entry counts. It does not expose or modify compendium documents.",
  method: "get",
  path: "/trails-of-destiny/catalogs",
  annotations: deterministicReadAnnotations,
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, TrailsCatalogListResult>(TRAILS_COMMANDS.LIST_CATALOGS),
};

const getCatalogDescriptor: EndpointDescriptor<TrailsCatalogInput, TrailsCatalogResult> = {
  name: "trails_get_catalog",
  description:
    "Reads sanitized canonical entries from one allowlisted, accessible Trails catalog using portable catalog IDs. It does not expose UUIDs as identities or modify the pack.",
  method: "get",
  path: "/trails-of-destiny/catalogs/:packId",
  inputSchema: catalogSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsCatalogInput, TrailsCatalogResult>(TRAILS_COMMANDS.GET_CATALOG, input),
};

const evaluateCreationDescriptor: EndpointDescriptor<
  TrailsActorIdInput,
  TrailsCreationReadinessResult
> = {
  name: "trails_evaluate_creation",
  description:
    "Evaluates an authorized actor's redacted creation readiness against runtime catalogs and returns findings, unmapped values, and manual boundaries only. It does not apply repairs or update documents.",
  method: "get",
  path: "/trails-of-destiny/actors/:id/creation-readiness",
  inputSchema: actorIdSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsActorIdInput, TrailsCreationReadinessResult>(
      TRAILS_COMMANDS.EVALUATE_CREATION,
      input,
    ),
};

const rollActionDescriptor: EndpointDescriptor<TrailsActionRollInput, TrailsActionRollResult> = {
  name: "trails_roll_action",
  description:
    "Uses the Trails runtime RNG to produce action or skill roll evidence. It does not accept caller-supplied die results and does not spend resources, apply effects, update documents, or post chat.",
  method: "post",
  path: "/trails-of-destiny/rolls/action",
  inputSchema: actionRollSchema,
  annotations: randomPreviewAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsActionRollInput, TrailsActionRollResult>(
      TRAILS_COMMANDS.ROLL_ACTION,
      input,
    ),
};

const previewInitiativeDescriptor: EndpointDescriptor<
  TrailsInitiativeInput,
  TrailsInitiativeResult
> = {
  name: "trails_preview_initiative",
  description:
    "Uses the Trails runtime RNG to preview initiative groups. Ties remain manual; it does not write Combat initiative, advance rounds, or change documents.",
  method: "post",
  path: "/trails-of-destiny/previews/initiative",
  inputSchema: initiativeSchema,
  annotations: randomPreviewAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsInitiativeInput, TrailsInitiativeResult>(
      TRAILS_COMMANDS.PREVIEW_INITIATIVE,
      input,
    ),
};

const previewThreatContestDescriptor: EndpointDescriptor<
  TrailsThreatContestInput,
  TrailsThreatContestResult
> = {
  name: "trails_preview_threat_contest",
  description:
    "Previews an attack or assault contest from supplied totals. It does not validate target eligibility, spend reaction resources, apply damage, or change Actor state.",
  method: "post",
  path: "/trails-of-destiny/previews/threat-contest",
  inputSchema: threatContestSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsThreatContestInput, TrailsThreatContestResult>(
      TRAILS_COMMANDS.PREVIEW_THREAT_CONTEST,
      input,
    ),
};

const previewDamageDescriptor: EndpointDescriptor<
  TrailsDamagePreviewInput,
  TrailsDamagePreviewResult
> = {
  name: "trails_preview_damage",
  description:
    "Previews an already-adjudicated post-mitigation damage amount and preserves manual-review findings. It does not adjudicate armor or update Actors, equipment, conditions, timers, or chat.",
  method: "post",
  path: "/trails-of-destiny/previews/damage",
  inputSchema: damageSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsDamagePreviewInput, TrailsDamagePreviewResult>(
      TRAILS_COMMANDS.PREVIEW_DAMAGE,
      input,
    ),
};

const previewRecoveryDescriptor: EndpointDescriptor<
  TrailsRecoveryPreviewInput,
  TrailsRecoveryPreviewResult
> = {
  name: "trails_preview_recovery",
  description:
    "Builds a non-authoritative recovery plan from a resource snapshot, explicit eligibility, and optional recorded d10 evidence. Daily claims remain unverified and no recovery is applied.",
  method: "post",
  path: "/trails-of-destiny/previews/recovery",
  inputSchema: recoverySchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsRecoveryPreviewInput, TrailsRecoveryPreviewResult>(
      TRAILS_COMMANDS.PREVIEW_RECOVERY,
      input,
    ),
};

const getExperienceProgressDescriptor: EndpointDescriptor<
  TrailsExperienceProgressInput,
  TrailsExperienceProgressResult
> = {
  name: "trails_get_experience_progress",
  description:
    "Calculates level progress from total experience using only the published level 1-50 table. It reports table exhaustion and does not extrapolate or update an Actor.",
  method: "get",
  path: "/trails-of-destiny/experience/:totalExperience",
  inputSchema: experienceSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsExperienceProgressInput, TrailsExperienceProgressResult>(
      TRAILS_COMMANDS.EXPERIENCE_PROGRESS,
      input,
    ),
};

const previewBuilderDescriptor: EndpointDescriptor<
  TrailsBuilderPreviewInput,
  TrailsBuilderPreviewResult
> = {
  name: "trails_preview_builder",
  description:
    "Parses, validates, and previews at most 2 MB of Trails builder JSON, returning issues and unmapped values. Even an issue-free preview does not authorize or perform actor creation, reconciliation, or any persistence.",
  method: "post",
  path: "/trails-of-destiny/builder/preview",
  inputSchema: builderSchema,
  annotations: deterministicReadAnnotations,
  handler: (input, { foundryClient }) =>
    foundryClient.call<TrailsBuilderPreviewInput, TrailsBuilderPreviewResult>(
      TRAILS_COMMANDS.PREVIEW_BUILDER,
      input,
    ),
};

export const trailsEndpointDescriptors: AnyEndpointDescriptor[] = [
  getConfigDescriptor,
  getActorSheetDescriptor,
  getActorInventoryDescriptor,
  listCatalogsDescriptor,
  getCatalogDescriptor,
  evaluateCreationDescriptor,
  rollActionDescriptor,
  previewInitiativeDescriptor,
  previewThreatContestDescriptor,
  previewDamageDescriptor,
  previewRecoveryDescriptor,
  getExperienceProgressDescriptor,
  previewBuilderDescriptor,
];
