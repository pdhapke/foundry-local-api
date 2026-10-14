import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  createPinnedWebhookLookup,
  isPublicAddress,
  normalizeCallbackUrl,
  PublicHttpsWebhookClient,
  signingKey,
  webhookHeaders,
  type WebhookRequest,
} from "./webhook.js";
import { FIXTURE_NOW, fixtureSecret } from "./test-support.js";

const input: WebhookRequest = {
  url: "https://callback.example.com/event",
  secret: fixtureSecret,
  subscriptionId: `sub-${"a".repeat(64)}`,
  eventId: `turn-${"b".repeat(64)}`,
  body: '{"fixture":"é"}',
};

for (const pin of [
  { address: "8.8.8.8", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
]) {
  for (const all of [false, true]) {
    void test(`pinned IPv${pin.family} lookup returns the Node callback shape for all=${all}`, () => {
      const lookup = createPinnedWebhookLookup(pin);
      let callbacks = 0;
      lookup("callback.example.com", { all }, (error, result, family) => {
        callbacks++;
        assert.equal(error, null);
        if (all) {
          assert.deepEqual(result, [pin]);
          assert.equal(family, undefined);
        } else {
          assert.equal(result, pin.address);
          assert.equal(family, pin.family);
        }
      });
      assert.equal(callbacks, 1);
    });
  }
}

void test("pinned lookup honors default and explicit families without falling back to DNS", () => {
  const lookup = createPinnedWebhookLookup({ address: "8.8.8.8", family: 4 });
  for (const options of [{}, { family: 0 }, { family: 4 }, { family: "IPv4" as const }]) {
    lookup("different.example.com", options, (error, result, family) => {
      assert.equal(error, null);
      assert.equal(result, "8.8.8.8");
      assert.equal(family, 4);
    });
  }
  for (const all of [false, true]) {
    for (const family of [6, "IPv6" as const]) {
      lookup("callback.example.com", { all, family }, (error, result, returnedFamily) => {
        assert.equal(error?.code, "ENOTFOUND");
        assert.deepEqual(result, all ? [] : "");
        assert.equal(returnedFamily, undefined);
      });
    }
  }
  const ipv6 = createPinnedWebhookLookup({ address: "2606:4700:4700::1111", family: 6 });
  ipv6("callback.example.com", { all: true, family: "IPv6" }, (error, result) => {
    assert.equal(error, null);
    assert.deepEqual(result, [{ address: "2606:4700:4700::1111", family: 6 }]);
  });
  ipv6("callback.example.com", { family: 4 }, (error, result) => {
    assert.equal(error?.code, "ENOTFOUND");
    assert.equal(result, "");
  });
});

void test("pinned lookup refuses unsafe or mismatched pins and snapshots the validated address", () => {
  assert.throws(() => createPinnedWebhookLookup({ address: "127.0.0.1", family: 4 }));
  assert.throws(() => createPinnedWebhookLookup({ address: "8.8.8.8", family: 6 }));
  const pin = { address: "8.8.8.8", family: 4 };
  const lookup = createPinnedWebhookLookup(pin);
  pin.address = "127.0.0.1";
  pin.family = 6;
  lookup("callback.example.com", { all: true }, (error, result) => {
    assert.equal(error, null);
    assert.deepEqual(result, [{ address: "8.8.8.8", family: 4 }]);
  });
});
void test("callback validation rejects credentials, insecure protocols, private addresses and nonstandard ports", () => {
  for (const value of [
    "http://example.com/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://x.internal/hook",
    "https://user:pass@example.com/hook",
    "https://example.com:444/hook",
    "https://example.com/hook#fragment",
    "https://2130706433/hook",
  ])
    assert.throws(() => normalizeCallbackUrl(value));
  assert.equal(
    normalizeCallbackUrl("https://callback.example.com:443/hook"),
    "https://callback.example.com/hook",
  );
});
void test("address validation rejects private, special and mapped ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "127.1.2.3",
    "169.254.1.2",
    "172.31.1.2",
    "192.168.1.2",
    "100.64.1.2",
    "198.18.1.2",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.1.1.1",
    "255.255.255.255",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "invalid",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
void test("Standard Webhooks signs exact UTF-8 bytes, ID and fresh timestamp", () => {
  const headers = webhookHeaders(input, FIXTURE_NOW);
  const timestamp = Math.floor(FIXTURE_NOW / 1000);
  const expected = createHmac("sha256", Buffer.alloc(32, 7))
    .update(`${input.eventId}.${timestamp}.${input.body}`)
    .digest("base64");
  assert.equal(headers["webhook-signature"], `v1,${expected}`);
  assert.equal(headers["webhook-id"], input.eventId);
  assert.equal(headers["X-MCP-Subscription-Id"], input.subscriptionId);
  assert.notEqual(
    webhookHeaders(input, FIXTURE_NOW + 1000)["webhook-signature"],
    headers["webhook-signature"],
  );
  assert.equal(
    webhookHeaders(
      { ...input, previousSecret: `whsec_${Buffer.alloc(24, 8).toString("base64")}` },
      FIXTURE_NOW,
    )["webhook-signature"]!.split(" ").length,
    2,
  );
});
void test("signing keys enforce canonical base64 and the documented byte bounds", () => {
  for (const secret of [
    "token",
    "whsec_%%%%",
    "whsec_A",
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
  ])
    assert.throws(() => signingKey(secret));
  assert.equal(signingKey(fixtureSecret).length, 32);
});
void test("DNS is rechecked each send, all addresses must be public and the connection is pinned", async () => {
  let lookups = 0;
  let posts = 0;
  const client = new PublicHttpsWebhookClient(
    async () => {
      lookups++;
      return [{ address: lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    },
    async (url, address, body, headers) => {
      posts++;
      assert.equal(url.hostname, "callback.example.com");
      assert.equal(address.address, "8.8.8.8");
      assert.equal(body, input.body);
      assert.ok(headers["webhook-signature"]);
      return { status: 204, body: "" };
    },
    () => FIXTURE_NOW,
  );
  await client.send(input, new AbortController().signal);
  await assert.rejects(client.send(input, new AbortController().signal));
  assert.equal(posts, 1);
  const mixed = new PublicHttpsWebhookClient(
    async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    async () => {
      throw new Error("Must not connect");
    },
  );
  await assert.rejects(mixed.send(input, new AbortController().signal));
});
void test("callback verification requires 2xx and an exact echoed single-use challenge", async () => {
  let response = { status: 200, body: '{"challenge":"fixture-challenge"}' };
  let sent = "";
  const client = new PublicHttpsWebhookClient(
    async () => [{ address: "8.8.8.8", family: 4 }],
    async (_url, _address, body) => {
      sent = body;
      return response;
    },
    () => FIXTURE_NOW,
    () => "fixture-challenge",
  );
  await client.verify(input.url, fixtureSecret, input.subscriptionId, new AbortController().signal);
  assert.deepEqual(JSON.parse(sent), { type: "verification", challenge: "fixture-challenge" });
  response = { status: 200, body: '{"challenge":"wrong"}' };
  await assert.rejects(
    client.verify(input.url, fixtureSecret, input.subscriptionId, new AbortController().signal),
  );
  response = { status: 302, body: '{"challenge":"fixture-challenge"}' };
  await assert.rejects(
    client.verify(input.url, fixtureSecret, input.subscriptionId, new AbortController().signal),
  );
});
void test("cancelled sends perform no resolution or request; oversized bodies are refused", async () => {
  let called = false;
  const client = new PublicHttpsWebhookClient(async () => {
    called = true;
    return [];
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.send(input, abort.signal));
  assert.equal(called, false);
  assert.throws(() => webhookHeaders({ ...input, body: "x".repeat(262145) }, FIXTURE_NOW));
});
