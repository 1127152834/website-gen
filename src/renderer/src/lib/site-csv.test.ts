import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSiteCsv } from "./site-csv.ts";
test("CSV imports UTF8 BOM, aliases, quoted commas, multiline and escaped quotes", () => {
  const [site] = parseSiteCsv('\uFEFFdomain,brand,niche,count,price_min,price_max\r\nshop.example,"Brand ""One""","bags,\ntravel",12,20,50\r\n');
  assert.equal(site.brand, 'Brand "One"'); assert.equal(site.categories, "bags,\ntravel"); assert.equal(site.count, 12); assert.equal(site.priceMax, 50);
});
test("CSV validates rows with shared forms validators and rejects malformed content", () => {
  for (const text of ['domain,niche\nx.example,"oops', 'domain,niche,count\nx.example,bags,201', 'domain,niche\nx.example,bags\nx.example,bags', 'domain,niche,price_min\nx.example,bags,no', 'domain,niche\nhttps://x.example,bags', 'domain,niche\nx.example,"bags"oops']) assert.throws(() => parseSiteCsv(text));
  assert.equal(parseSiteCsv("域名,类目\nx.example,bags")[0].count, 20);
});
