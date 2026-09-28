import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DND5E_SIMULATION_COMMANDS } from "@foundry-local-api/shared";
import { dnd5eSimulationEndpointDescriptors } from "./dnd5e-simulation.js";
import type { EndpointContext } from "./types.js";
void describe("simulation endpoint", () => {
  void it("routes only the bounded simulation command", async () => {
    let called = "";
    await dnd5eSimulationEndpointDescriptors[0]!.handler(
      {
        effectiveUserId: "gm",
        actorId: "a",
        action: { kind: "save", modifier: 2, dc: 10 },
        noPersist: true,
        expectedRevisions: [{ kind: "actor", id: "a", revision: "1" }],
        expectedSystemVersion: "6.0.3",
      },
      {
        foundryClient: {
          getCapabilityReport: () => ({
            clients: [
              {
                clientId: "gm-client",
                userId: "gm",
                lane: "gm",
                isGM: true,
                optedIn: true,
                connectedAt: 1,
                capabilities: [DND5E_SIMULATION_COMMANDS.SIMULATE],
              },
            ],
          }),
          call: (name: string) => {
            called = name;
            return Promise.resolve({});
          },
        },
      } as unknown as EndpointContext,
    );
    assert.equal(called, DND5E_SIMULATION_COMMANDS.SIMULATE);
    assert.equal(dnd5eSimulationEndpointDescriptors[0]!.annotations?.readOnlyHint, true);
  });

  void it("requires explicit no-persist mode, revisions, and exactly one action shape", () => {
    const schema = dnd5eSimulationEndpointDescriptors[0]!.inputSchema!;
    const base = {
      effectiveUserId: "gm",
      actorId: "a",
      expectedSystemVersion: "6.0.3",
      noPersist: true,
      expectedRevisions: [{ kind: "actor", id: "a", revision: "1" }],
    };
    assert.equal(
      schema.safeParse({ ...base, actions: [{ kind: "rest", restType: "long" }] }).success,
      true,
    );
    assert.equal(schema.safeParse({ ...base }).success, false);
    assert.equal(
      schema.safeParse({
        ...base,
        action: { kind: "rest", restType: "long" },
        actions: [{ kind: "rest", restType: "short" }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...base, noPersist: false, action: { kind: "rest", restType: "long" } })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...base,
        action: { kind: "rest", restType: "long" },
        expectedRevisions: [
          { kind: "actor", id: "a", revision: "1" },
          { kind: "actor", id: "a", revision: "1" },
        ],
      }).success,
      false,
    );
  });
});
