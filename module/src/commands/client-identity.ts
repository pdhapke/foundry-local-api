import {
  CLIENT_READINESS_COMMANDS,
  ProtocolError,
  type ClientIdentityAdoptionCommandInput,
  type ClientEnrolledIdentityAdoptionCommandInput,
  type ClientIdentityAdoptionResult,
} from "@foundry-local-api/shared";

import {
  adoptClientId,
  getClientId,
  getClientLane,
  stageIdentityHandoff,
} from "../bridge-client.js";
import { registerCommand } from "../command-registry.js";

const STORAGE_KEY = "foundry-local-api.identity-adoptions.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_RECORDS = 20;

type Record = {
  input: Omit<ClientIdentityAdoptionCommandInput, "identityHandoffProof">;
  state: "pending" | "applied";
  result?: ClientIdentityAdoptionResult;
};

function storage(): Storage {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // Fail closed below.
  }
  throw new ProtocolError({
    code: "INCOMPLETE_RESULT",
    message: "Durable identity-adoption storage is unavailable.",
    retryable: false,
  });
}

function load(target: Storage): Record[] {
  const raw = target.getItem(STORAGE_KEY);
  if (!raw) return [];
  if (raw.length > 65_536) throw new Error("Identity-adoption state exceeds its bound");
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.length > MAX_RECORDS)
    throw new Error("Invalid identity-adoption state");
  return value as Record[];
}

function save(target: Storage, records: Record[]): void {
  const serialized = JSON.stringify(records.slice(-MAX_RECORDS));
  target.setItem(STORAGE_KEY, serialized);
  if (target.getItem(STORAGE_KEY) !== serialized)
    throw new Error("Identity-adoption write verification failed");
}

function invalid(message: string): never {
  throw new ProtocolError({ code: "INVALID_PAYLOAD", message, retryable: false });
}

export function adoptExactClientIdentity(
  input: ClientIdentityAdoptionCommandInput,
): ClientIdentityAdoptionResult {
  if (!game.user.isGM || getClientLane() !== "gm") {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Only the authenticated GM command lane may adopt a client identity.",
      retryable: false,
    });
  }
  return adoptAuthorizedIdentity(input);
}

export function adoptExactEnrolledClientIdentity(
  input: ClientEnrolledIdentityAdoptionCommandInput,
): ClientIdentityAdoptionResult {
  const lane = getClientLane();
  const consent = game.settings.get<boolean>("foundry-local-api", "allowRemoteControl");
  if (
    (lane !== "player" && lane !== "tv") ||
    lane !== input.expectedLane ||
    game.user.id !== input.expectedUserId ||
    consent !== true
  ) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Identity adoption requires the exact enrolled, consenting player or TV client.",
      retryable: false,
    });
  }
  return adoptAuthorizedIdentity(input);
}

function adoptAuthorizedIdentity(
  input: ClientIdentityAdoptionCommandInput,
): ClientIdentityAdoptionResult {
  if (!CORRELATION.test(input.correlationId)) invalid("Invalid adoption correlation ID.");
  if (!UUID.test(input.expectedClientId) || !UUID.test(input.desiredClientId)) {
    invalid("Client identities must be UUIDs.");
  }
  if (input.expectedClientId === input.desiredClientId)
    invalid("The desired identity must differ.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.identityHandoffProof))
    invalid("Invalid identity handoff proof.");

  const durableInput = {
    correlationId: input.correlationId,
    expectedClientId: input.expectedClientId,
    desiredClientId: input.desiredClientId,
  };

  const target = storage();
  let records: Record[];
  try {
    records = load(target);
  } catch {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Durable identity-adoption state is unreadable.",
      retryable: false,
    });
  }
  const prior = records.find((record) => record.input.correlationId === input.correlationId);
  if (prior && JSON.stringify(prior.input) !== JSON.stringify(durableInput)) {
    throw new ProtocolError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "A different identity adoption already used this correlation ID.",
      retryable: false,
      correlationId: input.correlationId,
    });
  }
  if (prior?.state === "applied" && prior.result) {
    try {
      stageIdentityHandoff(input.desiredClientId, input.identityHandoffProof);
    } catch {
      throw new ProtocolError({
        code: "INCOMPLETE_RESULT",
        message: "The browser-bound identity handoff could not be restaged.",
        retryable: false,
      });
    }
    return { ...prior.result, replayed: true };
  }

  const observed = getClientId();
  if (observed !== input.expectedClientId && observed !== input.desiredClientId) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The adoption request does not match this GM client identity.",
      retryable: false,
    });
  }
  if (!prior) {
    records.push({ input: structuredClone(durableInput), state: "pending" });
    try {
      save(target, records);
    } catch {
      throw new ProtocolError({
        code: "INCOMPLETE_RESULT",
        message: "Identity adoption intent could not be durably recorded.",
        retryable: false,
      });
    }
  }
  try {
    stageIdentityHandoff(input.desiredClientId, input.identityHandoffProof);
  } catch {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "The browser-bound identity handoff could not be staged.",
      retryable: false,
    });
  }
  if (observed === input.expectedClientId)
    adoptClientId(input.expectedClientId, input.desiredClientId);

  const result: ClientIdentityAdoptionResult = {
    correlationId: input.correlationId,
    acknowledged: true,
    replayed: prior !== undefined,
    acknowledgedAt: new Date().toISOString(),
    clientUserId: game.user.id,
    executingClientId: input.expectedClientId,
    adoptedClientId: input.desiredClientId,
    reloadRequired: true,
  };
  const record = records.find(
    (candidate) => candidate.input.correlationId === input.correlationId,
  )!;
  record.state = "applied";
  record.result = result;
  try {
    save(target, records);
  } catch {
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Identity adoption succeeded but acknowledgement could not be durably recorded.",
      retryable: true,
    });
  }
  return structuredClone(result);
}

registerCommand(CLIENT_READINESS_COMMANDS.ADOPT_IDENTITY, adoptExactClientIdentity);
registerCommand(
  CLIENT_READINESS_COMMANDS.ADOPT_ENROLLED_IDENTITY,
  adoptExactEnrolledClientIdentity,
);
