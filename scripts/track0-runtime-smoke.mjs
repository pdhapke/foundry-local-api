import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const port = 3941;
const apiKey = "track0-smoke-key-local-only";
const server = spawn(process.execPath, [resolve(root, "server/dist/index.js")], {
  cwd: resolve(root, "server"),
  env: {
    ...process.env,
    PORT: String(port),
    API_KEY: apiKey,
    NODE_ENV: "test",
    MCP_STDIO: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));

const deadline = Date.now() + 10_000;
while (!output.includes("server listening") && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
assert.match(output, /server listening/, "built server did not become ready");

function connect(identity) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge?apiKey=${apiKey}`);
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ id: request.id, ok: true, result: {} }));
  });
  return once(socket, "open").then(() => {
    socket.send(
      JSON.stringify({
        kind: "hello",
        identity,
        versions: {
          protocolVersion: 2,
          foundryVersion: "14.368",
          systemId: "dnd5e",
          systemVersion: "6.0.3",
          moduleVersion: "0.1.0",
          transport: "websocket",
        },
        capabilities: ["track0.negotiation"],
      }),
    );
    return socket;
  });
}

const sockets = [];
try {
  sockets.push(
    await connect({
      clientId: "track0-smoke-gm",
      userId: "smoke-gm",
      userName: "Smoke GM",
      isGM: true,
      lane: "gm",
      optedIn: true,
    }),
  );
  sockets.push(
    await connect({
      clientId: "track0-smoke-player",
      userId: "smoke-player",
      userName: "Smoke Player",
      isGM: false,
      lane: "player",
      optedIn: true,
    }),
  );

  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
    headers: { "x-api-key": apiKey },
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(
    report.clients.map((client) => [client.clientId, client.lane]),
    [
      ["track0-smoke-gm", "gm"],
      ["track0-smoke-player", "player"],
    ],
  );
  assert.equal(report.protocolVersion, 2);
  assert.ok(report.capabilities.every((entry) => entry.liveVerified));
  console.log(
    JSON.stringify({
      ok: true,
      protocolVersion: report.protocolVersion,
      clientLanes: report.clients.map((client) => client.lane),
      capabilityStates: report.capabilities.map((entry) => [entry.id, entry.state]),
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
}
