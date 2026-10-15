import { test } from "node:test";
import assert from "node:assert/strict";
import { HOSTINGER_MAIL, planMailDns, txtValue, type ZoneGroup } from "./mail.ts";

const rec = (...contents: string[]) => contents.map((content) => ({ content, is_disabled: false }));
/** shopunitycart.com 实测的区域（Hostinger 邮箱开通后的标准记录） */
const complete = (): ZoneGroup[] => [
  ...HOSTINGER_MAIL.dkim.map((k) => ({ name: k.name, type: "CNAME", ttl: 300, records: rec(k.content) })),
  { name: "_dmarc", type: "TXT", ttl: 3600, records: rec('"v=DMARC1; p=none"') },
  { name: "@", type: "ALIAS", ttl: 300, records: rec("shopunitycart.com.cdn.hstgr.net.") },
  { name: "@", type: "TXT", ttl: 3600, records: rec('"v=spf1 include:_spf.mail.hostinger.com ~all"') },
  { name: "@", type: "MX", ttl: 14400, records: rec("10 mx2.hostinger.com.", "5 mx1.hostinger.com.") },
];
const without = (zone: ZoneGroup[], name: string, type: string) => zone.filter((z) => !(z.name === name && z.type === type));

test("a complete Hostinger Email zone needs nothing", () => {
  const plan = planMailDns(complete());
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.checks.map((c) => `${c.key}:${c.ok}`), ["MX:true", "SPF:true", "DKIM:true", "DMARC:true"]);
});

test("missing DKIM and DMARC records are added", () => {
  let zone = without(complete(), "_dmarc", "TXT");
  zone = without(zone, "hostingermail-b._domainkey", "CNAME");
  const plan = planMailDns(zone);
  assert.deepEqual(plan.updates.map((u) => `${u.type} ${u.name} ${u.records[0].content}`), [
    "CNAME hostingermail-b._domainkey hostingermail-b.dkim.mail.hostinger.com.",
    'TXT _dmarc "v=DMARC1; p=none"',
  ]);
});

test("SPF is merged: other TXT records and other senders are kept, Hostinger is inserted before all", () => {
  const zone = without(complete(), "@", "TXT");
  zone.push({ name: "@", type: "TXT", ttl: 3600, records: rec('"google-site-verification=abc"', '"v=spf1 include:_spf.google.com -all"') });
  const [txt] = planMailDns(zone).updates;
  assert.deepEqual(txt.records.map((r) => r.content), ['"google-site-verification=abc"', '"v=spf1 include:_spf.google.com include:_spf.mail.hostinger.com -all"']);
});

test("two SPF records are merged into one", () => {
  const zone = without(complete(), "@", "TXT");
  zone.push({ name: "@", type: "TXT", records: rec('"v=spf1 include:_spf.mail.hostinger.com ~all"', '"v=spf1 include:sendgrid.net ~all"') });
  const plan = planMailDns(zone);
  assert.equal(plan.checks.find((c) => c.key === "SPF")!.ok, false);
  assert.deepEqual(plan.updates[0].records.map((r) => txtValue(r.content)), ["v=spf1 include:_spf.mail.hostinger.com include:sendgrid.net ~all"]);
});

test("MX pointing to another mail service is reported but never overwritten; an empty zone gets MX and SPF", () => {
  const zone = without(complete(), "@", "MX");
  zone.push({ name: "@", type: "MX", records: rec("1 aspmx.l.google.com.") });
  const plan = planMailDns(zone);
  assert.equal(plan.checks.find((c) => c.key === "MX")!.ok, false);
  assert.ok(!plan.updates.some((u) => u.type === "MX"));

  const empty = planMailDns([]);
  assert.deepEqual(empty.updates.map((u) => `${u.type} ${u.name}`), [
    "MX @", "TXT @", ...HOSTINGER_MAIL.dkim.map((k) => `CNAME ${k.name}`), "TXT _dmarc",
  ]);
});

test("TXT values with quotes or split into chunks are read as one string", () => {
  assert.equal(txtValue('"v=spf1 include:a" " ~all"'), "v=spf1 include:a ~all");
  assert.equal(txtValue("v=DMARC1; p=none"), "v=DMARC1; p=none");
});
