import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(import.meta.dirname, "..");
const serverRoot = resolve(root, "server");
const apiKey = process.env.SMOKE_API_KEY ?? "trails-live-smoke-key-2026";
assert.ok(apiKey, "server/.env must contain API_KEY");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3940";
const mode = process.argv[2] ?? "rest-http-remote";
const results = [];
const permissionFixturePath =
  process.env.SMOKE_FIXTURE_FILE ?? "C:/dev/FoundryVtt/tmp/trails-permission-fixtures.json";

function record(surface, operation, status, note = "") {
  results.push({ surface, operation, status, ...(note ? { note } : {}) });
}

async function rest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "X-Api-Key": apiKey,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

const resources = {
  durability: { value: 10, max: 30 },
  health: { value: 8, max: 25 },
  vigor: { value: 12, max: 35 },
  mana: { value: 9, max: 40 },
  energy: { value: 80, max: 150 },
};

function argsFor(actorId, packId) {
  return {
    trails_get_config: {},
    trails_get_actor_sheet: { id: actorId },
    trails_get_actor_inventory: { id: actorId },
    trails_list_catalogs: {},
    trails_get_catalog: { packId },
    trails_evaluate_creation: { id: actorId },
    trails_roll_action: {
      kind: "skill",
      abilityId: "agi",
      skillId: "light-weapons",
      abilityDice: 1,
      skillDice: 1,
      otherDice: 0,
      abilityChallenges: 0,
      challenges: 0,
      chances: 0,
      charges: 0,
      conditionalDice: [],
    },
    trails_preview_initiative: {
      participants: [
        {
          id: actorId,
          label: "redacted smoke actor",
          bonusDice: 0,
          challenges: 0,
          charges: 0,
          sources: [],
        },
      ],
    },
    trails_preview_threat_contest: {
      classification: "attack",
      actionTotal: 15,
      passiveDefense: 15,
      reactionTotal: null,
    },
    trails_preview_damage: { durability: 10, health: 8, damage: 17 },
    trails_preview_recovery: {
      kind: "break",
      resources,
      stamina: 15,
      eligibility: {
        durability: true,
        health: true,
        vigor: true,
        mana: true,
        energy: true,
      },
    },
    trails_get_experience_progress: { totalExperience: 1000 },
    trails_preview_builder: {
      raw: JSON.stringify({
        version: 1,
        rulesVersion: "0.1",
        step: 0,
        name: "Redacted Smoke Preview",
        method: "array",
        scores: {},
        rolls: {},
        talents: [],
        connectionNotes: {},
        crafts: [],
        inventory: [],
        orbment: { lines: [], slots: {} },
        languages: [],
      }),
    },
  };
}

const restRoutes = {
  trails_get_config: ["GET", "/config"],
  trails_get_actor_sheet: ["GET", (a) => `/actors/${encodeURIComponent(a.id)}/sheet`],
  trails_get_actor_inventory: ["GET", (a) => `/actors/${encodeURIComponent(a.id)}/inventory`],
  trails_list_catalogs: ["GET", "/catalogs"],
  trails_get_catalog: ["GET", (a) => `/catalogs/${encodeURIComponent(a.packId)}`],
  trails_evaluate_creation: [
    "GET",
    (a) => `/actors/${encodeURIComponent(a.id)}/creation-readiness`,
  ],
  trails_roll_action: ["POST", "/rolls/action"],
  trails_preview_initiative: ["POST", "/previews/initiative"],
  trails_preview_threat_contest: ["POST", "/previews/threat-contest"],
  trails_preview_damage: ["POST", "/previews/damage"],
  trails_preview_recovery: ["POST", "/previews/recovery"],
  trails_get_experience_progress: ["GET", (a) => `/experience/${a.totalExperience}`],
  trails_preview_builder: ["POST", "/builder/preview"],
};

async function discoverFixtures() {
  const status = await rest("/api/status");
  const system = await rest("/api/system");
  assert.equal(status.foundryVersion, "14.368");
  assert.equal(system.id, "trails-of-destiny");
  assert.match(String(system.version), /^0\.1\./);
  const actors = await rest("/api/actors");
  assert.ok(Array.isArray(actors), "Actor list must be an array");
  let createdActorId;
  if (actors.length === 0) {
    const created = await rest("/api/actors", {
      method: "POST",
      body: JSON.stringify({ data: { name: "Redacted Trails Smoke Actor", type: "character" } }),
    });
    createdActorId = created?._id ?? created?.id;
    assert.equal(typeof createdActorId, "string");
    actors.push(created);
    record("fixture", "temporary actor", "created", "removed after smoke run");
  }
  const actorId = actors[0]?._id ?? actors[0]?.id;
  assert.equal(typeof actorId, "string");
  const catalogs = await rest("/api/integrations/trails-of-destiny/catalogs");
  const catalogRows = catalogs.catalogs ?? catalogs;
  assert.ok(Array.isArray(catalogRows));
  const accessible = catalogRows.find((row) => row.accessible !== false);
  const packId = accessible?.packId ?? accessible?.id;
  assert.equal(typeof packId, "string");
  record(
    "runtime",
    "versions",
    "pass",
    `Foundry ${status.foundryVersion}; Trails ${system.version}`,
  );
  return { actorId, packId, createdActorId };
}

async function runRest(actorId, packId) {
  const args = argsFor(actorId, packId);
  for (const [name, [method, routeValue]] of Object.entries(restRoutes)) {
    const route = typeof routeValue === "function" ? routeValue(args[name]) : routeValue;
    const path = `/api/integrations/trails-of-destiny${route}`;
    const body = method === "POST" ? JSON.stringify(args[name]) : undefined;
    const value = await rest(path, { method, body });
    assert.notEqual(value, undefined);
    record("REST", name, "pass");
  }

  for (const headers of [{}, { "X-Api-Key": "intentionally-wrong" }]) {
    const response = await fetch(`${baseUrl}/api/integrations/trails-of-destiny/config`, {
      headers,
    });
    assert.equal(response.status, 401);
  }
  record("REST", "missing/wrong API key", "pass", "401 for both");

  const missingActor = await fetch(
    `${baseUrl}/api/integrations/trails-of-destiny/actors/not-a-real-actor/sheet`,
    { headers: { "X-Api-Key": apiKey } },
  );
  assert.equal(missingActor.ok, false);
  record("REST", "unavailable actor", "pass", `HTTP ${missingActor.status}`);

  const serialized = JSON.stringify(
    await rest(`/api/integrations/trails-of-destiny/actors/${encodeURIComponent(actorId)}/sheet`),
  );
  for (const forbidden of ["biography", "campaignNotes", "sourceSnapshot", "adjudications"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `sensitive field ${forbidden}`);
  }
  record("REST", "actor redaction", "pass");
}

function makeClient(name) {
  return new Client({ name, version: "1.0.0" });
}

function parseToolResult(result, name) {
  assert.notEqual(result.isError, true, name);
  const block = result.content?.find((entry) => entry.type === "text");
  assert.equal(typeof block?.text, "string", `${name} must return JSON text`);
  return JSON.parse(block.text);
}

async function runMcpClient(surface, client, actorId, packId) {
  const args = argsFor(actorId, packId);
  const tools = await client.listTools();
  const trails = tools.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("trails_"))
    .sort();
  assert.deepEqual(trails, Object.keys(args).sort());
  record(surface, "tool catalog", "pass", `${trails.length} Trails tools`);
  for (const name of trails) {
    const result = await client.callTool({ name, arguments: args[name] });
    assert.notEqual(result.isError, true, name);
    record(surface, name, "pass");
  }
}

async function waitForTrailsTools(client) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const tools = await client.listTools();
    if (tools.tools.some((tool) => tool.name === "trails_get_config")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the Trails bridge/catalog to activate");
}

async function runHttp(actorId, packId) {
  const client = makeClient("trails-live-smoke-http");
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "X-Api-Key": apiKey } },
  });
  try {
    await client.connect(transport);
    await runMcpClient("Streamable HTTP MCP", client, actorId, packId);
    await transport.terminateSession();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runStdio(surface, entry, actorId, packId, env = {}) {
  const client = makeClient(`trails-live-smoke-${surface.toLowerCase().replaceAll(" ", "-")}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: serverRoot,
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await runMcpClient(surface, client, actorId, packId);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runInProcess() {
  const client = makeClient("trails-live-smoke-in-process");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(serverRoot, "dist", "index.js")],
    cwd: serverRoot,
    env: {
      ...process.env,
      MCP_STDIO: "true",
      PORT: process.env.SMOKE_PORT ?? "3940",
      API_KEY: apiKey,
    },
    stderr: "pipe",
  });
  let createdActorId;
  try {
    await client.connect(transport);
    await waitForTrailsTools(client);
    const actors = parseToolResult(
      await client.callTool({ name: "foundry_list_actors", arguments: {} }),
      "foundry_list_actors",
    );
    assert.ok(Array.isArray(actors));
    if (actors.length === 0) {
      const created = parseToolResult(
        await client.callTool({
          name: "foundry_create_actor",
          arguments: { data: { name: "Redacted Trails Smoke Actor", type: "character" } },
        }),
        "foundry_create_actor",
      );
      createdActorId = created?._id ?? created?.id;
      actors.push(created);
      record("fixture", "in-process temporary actor", "created", "removed after smoke run");
    }
    const actorId = actors[0]?._id ?? actors[0]?.id;
    assert.equal(typeof actorId, "string");
    const catalogResult = parseToolResult(
      await client.callTool({ name: "trails_list_catalogs", arguments: {} }),
      "trails_list_catalogs",
    );
    const catalogRows = catalogResult.catalogs ?? catalogResult;
    const accessible = catalogRows.find((row) => row.accessible !== false);
    const packId = accessible?.packId ?? accessible?.id;
    assert.equal(typeof packId, "string");
    await runMcpClient("in-process stdio MCP", client, actorId, packId);
  } finally {
    if (createdActorId) {
      parseToolResult(
        await client.callTool({
          name: "foundry_delete_actor",
          arguments: { id: createdActorId },
        }),
        "foundry_delete_actor",
      );
      record("fixture", "in-process temporary actor", "removed");
    }
    await client.close().catch(() => undefined);
  }
}

async function assertInactiveClient(surface, client) {
  const tools = await client.listTools();
  assert.equal(
    tools.tools.some((tool) => tool.name.startsWith("trails_")),
    false,
  );
  const deadline = Date.now() + 45_000;
  while (true) {
    const result = await client.callTool({ name: "foundry_get_status", arguments: {} });
    if (result.isError !== true) {
      const status = parseToolResult(result, "foundry_get_status");
      assert.equal(status.systemId, "dnd5e");
      break;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for non-Trails core bridge");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  record(surface, "core status", "pass");
  record(surface, "Trails catalog absent", "pass");
}

async function runNonTrailsRestHttpRemote() {
  const status = await rest("/api/status");
  assert.equal(status.systemId, "dnd5e");
  record("non-Trails REST", "core status", "pass", "dnd5e active");
  const inactive = await fetch(`${baseUrl}/api/integrations/trails-of-destiny/config`, {
    headers: { "X-Api-Key": apiKey },
  });
  const body = await inactive.json();
  assert.equal(inactive.status, 404);
  assert.equal(body?.error?.code, "INTEGRATION_INACTIVE");
  record("non-Trails REST", "inactive namespace", "pass", "404 INTEGRATION_INACTIVE");

  const httpClient = makeClient("trails-live-smoke-nontrails-http");
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "X-Api-Key": apiKey } },
  });
  try {
    await httpClient.connect(httpTransport);
    await assertInactiveClient("non-Trails Streamable HTTP MCP", httpClient);
    await httpTransport.terminateSession();
  } finally {
    await httpClient.close().catch(() => undefined);
  }

  const remoteClient = makeClient("trails-live-smoke-nontrails-remote");
  const remoteTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(serverRoot, "dist", "mcp-remote.js")],
    cwd: serverRoot,
    env: { ...process.env, PORT: new URL(baseUrl).port, API_KEY: apiKey },
    stderr: "pipe",
  });
  try {
    await remoteClient.connect(remoteTransport);
    await assertInactiveClient("non-Trails remote stdio MCP", remoteClient);
  } finally {
    await remoteClient.close().catch(() => undefined);
  }
}

async function runNonTrailsInProcess() {
  const client = makeClient("trails-live-smoke-nontrails-in-process");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(serverRoot, "dist", "index.js")],
    cwd: serverRoot,
    env: {
      ...process.env,
      MCP_STDIO: "true",
      PORT: process.env.SMOKE_PORT ?? "3940",
      API_KEY: apiKey,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await assertInactiveClient("non-Trails in-process stdio MCP", client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function preparePermissionFixtures() {
  const actor = await rest("/api/actors", {
    method: "POST",
    body: JSON.stringify({ data: { name: "Redacted Restricted Smoke Actor", type: "character" } }),
  });
  const user = await rest("/api/users", {
    method: "POST",
    body: JSON.stringify({ data: { name: "Restricted Smoke User", role: 1 } }),
  });
  const actorId = actor?._id ?? actor?.id;
  const userId = user?._id ?? user?.id;
  assert.equal(typeof actorId, "string");
  assert.equal(typeof userId, "string");
  await writeFile(permissionFixturePath, JSON.stringify({ actorId, userId }), "utf8");
  record("fixture", "restricted actor and user", "created", "identifiers stored outside logs");
}

async function runPermissionCheck() {
  const { actorId } = JSON.parse(await readFile(permissionFixturePath, "utf8"));
  const response = await fetch(
    `${baseUrl}/api/integrations/trails-of-destiny/actors/${encodeURIComponent(actorId)}/sheet`,
    { headers: { "X-Api-Key": apiKey } },
  );
  assert.equal(response.ok, false);
  record(
    "restricted bridge user",
    "unauthorized actor",
    "pass",
    `access rejected (HTTP ${response.status})`,
  );
}

async function runPackPermissionCheck() {
  const packId = process.env.SMOKE_RESTRICTED_PACK_ID ?? "trails-of-destiny.character-options";
  const path = `/api/integrations/trails-of-destiny/catalogs/${encodeURIComponent(packId)}`;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "X-Api-Key": apiKey },
  });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.equal(body.error.code, "HANDLER_ERROR");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["entries", "catalogId", "uuid", "_id", "sourceSnapshot"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `leaked field ${forbidden}`);
  }
  record("restricted bridge user", "unauthorized catalog REST", "pass", "generic HTTP 500");

  const catalogs = await rest("/api/integrations/trails-of-destiny/catalogs");
  const rows = catalogs.catalogs ?? catalogs;
  const restricted = rows.find((row) => row.packId === packId);
  assert.deepEqual(restricted, {
    packId,
    label: "Character Options",
    accessible: false,
    entryCount: null,
  });
  record("restricted bridge user", "unauthorized catalog listing", "pass", "no entry count");

  const client = makeClient("trails-live-smoke-pack-permission-http");
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "X-Api-Key": apiKey } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "trails_get_catalog",
      arguments: { packId },
    });
    assert.equal(result.isError, true);
    const resultText = JSON.stringify(result.content ?? []);
    for (const forbidden of ["entries", "catalogId", "uuid", "_id", "sourceSnapshot"]) {
      assert.equal(resultText.includes(`"${forbidden}"`), false, `MCP leaked field ${forbidden}`);
    }
    record("restricted bridge user", "unauthorized catalog MCP", "pass", "error result only");
    await transport.terminateSession();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function cleanupPermissionFixtures() {
  const { actorId, userId } = JSON.parse(await readFile(permissionFixturePath, "utf8"));
  await rest(`/api/actors/${encodeURIComponent(actorId)}`, { method: "DELETE" });
  await rest(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
  await unlink(permissionFixturePath);
  record("fixture", "restricted actor and user", "removed");
}

if (mode === "rest-http-remote") {
  const { actorId, packId, createdActorId } = await discoverFixtures();
  try {
    await runRest(actorId, packId);
    await runHttp(actorId, packId);
    await runStdio(
      "remote stdio MCP",
      resolve(serverRoot, "dist", "mcp-remote.js"),
      actorId,
      packId,
      { PORT: new URL(baseUrl).port, API_KEY: apiKey },
    );
  } finally {
    if (createdActorId) {
      await rest(`/api/actors/${encodeURIComponent(createdActorId)}`, { method: "DELETE" });
      record("fixture", "temporary actor", "removed");
    }
  }
} else if (mode === "in-process") {
  await runInProcess();
} else if (mode === "nontrails-rest-http-remote") {
  await runNonTrailsRestHttpRemote();
} else if (mode === "nontrails-in-process") {
  await runNonTrailsInProcess();
} else if (mode === "prepare-permissions") {
  await preparePermissionFixtures();
} else if (mode === "check-permissions") {
  await runPermissionCheck();
} else if (mode === "check-pack-permissions") {
  await runPackPermissionCheck();
} else if (mode === "cleanup-permissions") {
  await cleanupPermissionFixtures();
} else {
  throw new Error(`Unknown mode ${mode}`);
}

console.log(JSON.stringify({ mode, passed: results.length, results }, null, 2));
