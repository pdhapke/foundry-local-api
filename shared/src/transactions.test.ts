import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProtocolError } from "./foundations.js";
import { orderTransactionOperations, type TransactionOperation } from "./transactions.js";

const create = (operationId: string, dependsOn?: string[]): TransactionOperation => ({
  operationId,
  kind: "document.create",
  documentType: "JournalEntry",
  data: { name: operationId },
  ...(dependsOn ? { dependsOn } : {}),
});

void describe("transaction manifest ordering", () => {
  void it("orders dependencies stably", () => {
    assert.deepEqual(
      orderTransactionOperations([
        create("third", ["second"]),
        create("first"),
        create("second", ["first"]),
      ]).map(({ operationId }) => operationId),
      ["first", "second", "third"],
    );
  });

  void it("rejects duplicate, unknown, and cyclic dependencies", () => {
    for (const operations of [
      [create("same"), create("same")],
      [create("one", ["missing"])],
      [create("one", ["two"]), create("two", ["one"])],
    ]) {
      assert.throws(() => orderTransactionOperations(operations), ProtocolError);
    }
  });
});
