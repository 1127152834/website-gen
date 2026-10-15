import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicies, claimProblems, htmlToBlocks, parsePolicies, type Facts, type Policies } from "./content.ts";
import { costRange, splitVariants } from "./cj.ts";
import { parseUsAddress } from "./store.ts";

const facts: Facts = {
  brand: "Nordic Paws", domain: "nordicpaws.com", email: "support@nordicpaws.com", categories: ["dog beds"],
  entity: { kind: "company", name: "Nordic Paws LLC", address: "1 Main St", supportEmail: "auto", phone: "+1 512 555 0100", processingDays: [1, 3], transitDays: [5, 10] },
};
const pad = " This sentence only makes the document long enough to count as a real policy page for the length check.".repeat(2);
const good = (): Policies => ({
  shipping: `<p>Orders ship in 1-3 business days and arrive in 5 to 10 business days. Free shipping on orders of $49 or more, otherwise $4.99. Email support@nordicpaws.com.${pad}</p>`,
  returns: `<p>Return items within a 30-day window. Refunds take 5–7 business days. Email support@nordicpaws.com.${pad}</p>`,
  privacy: `<p>Nordic Paws LLC runs this store. Email support@nordicpaws.com.${pad}</p>`,
  terms: `<p>Nordic Paws LLC runs this store. Email support@nordicpaws.com.${pad}</p>`,
});

test("policies that state every promised fact pass, also after WordPress typography", () => {
  assert.deepEqual(checkPolicies(good(), facts), []);
  const rendered = good();
  rendered.returns = rendered.returns.replace("5–7", "5&#8211;7");
  assert.deepEqual(checkPolicies(rendered, facts), []);
});

test("policies with a missing fact or an invented number are rejected", () => {
  const p = good();
  p.returns = p.returns.replace("30-day", "60-day");
  p.shipping += "<p>Express shipping costs $12.</p>";
  const problems = checkPolicies(p, facts).join("\n");
  assert.match(problems, /return window/);
  assert.match(problems, /"60 day" is not in the facts/);
  assert.match(problems, /"\$12" is not in the facts/);
});

test("unprovable claims are caught without flagging ordinary words", () => {
  assert.equal(claimProblems("Founded in 2015, our award-winning, non-toxic beds").length, 3);
  assert.deepEqual(claimProblems("A rewarding nap on a soft bed."), []);
});

test("the policy reply format is split into four documents and turned into core blocks", () => {
  const p = parsePolicies("=== SHIPPING ===\n<h2>A</h2>\n=== RETURNS ===\n<ul><li>x</li><li>y</li></ul>\n=== PRIVACY ===\n<p>p</p>\n=== TERMS ===\n<p>t</p>");
  assert.deepEqual(Object.keys(p), ["shipping", "returns", "privacy", "terms"]);
  assert.equal(htmlToBlocks(p.shipping), '<!-- wp:heading -->\n<h2 class="wp-block-heading">A</h2>\n<!-- /wp:heading -->');
  assert.equal((htmlToBlocks(p.returns).match(/<!-- wp:list-item -->/g) ?? []).length, 2);
  assert.equal(htmlToBlocks('<p onclick="x">Hi <script>bad()</script><a href="javascript:1">l</a></p>'), "<!-- wp:paragraph -->\n<p>Hi bad()<a>l</a></p>\n<!-- /wp:paragraph -->");
});

test("CJ variant keys split into named attributes, or fall back to one option", () => {
  assert.deepEqual(splitVariants(["Color", "Size"], ["Light Grey-S", "Light Grey-M"]), [{ Color: "Light Grey", Size: "S" }, { Color: "Light Grey", Size: "M" }]);
  assert.deepEqual(splitVariants(["Color", "Size"], ["Dark-Blue-S"]), [{ Option: "Dark-Blue-S" }]);
  assert.deepEqual(costRange("5.99 -- 7.40"), [5.99, 7.4]);
});

test("US addresses are split into Woo store fields", () => {
  assert.deepEqual(parseUsAddress("1 Main St, Suite 2, Austin, TX 78701, United States"), { street: "1 Main St, Suite 2", city: "Austin", state: "TX", zip: "78701" });
  assert.equal(parseUsAddress("Flat 3, 8 Queen's Road, Hong Kong").state, "");
});
