import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal, unseal } from "./secrets.ts";

const key = randomBytes(32);

test("sealed secrets round-trip and never contain the plaintext", () => {
  const blob = seal(key, "hostinger-token-1234");
  assert.equal(unseal(key, blob), "hostinger-token-1234");
  assert.ok(!Buffer.from(blob).toString("latin1").includes("hostinger-token"));
});

test("the same plaintext seals differently each time", () => {
  assert.notDeepEqual(seal(key, "same"), seal(key, "same"));
});

test("a tampered blob or a wrong key is rejected", () => {
  const blob = Buffer.from(seal(key, "secret"));
  blob[blob.length - 1] ^= 1;
  assert.throws(() => unseal(key, blob));
  assert.throws(() => unseal(randomBytes(32), seal(key, "secret")));
});
