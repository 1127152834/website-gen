import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "./db.ts";
import { createTriageQueue, type JobRegistration } from "./mail-triage-queue.ts";
import { createTriageScheduler } from "./mail-triage-scheduler.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "triage-queue-")); const path = join(dir, "queue.sqlite");
  let db = openDb(path); migrate(db); let now = Date.parse("2026-10-16T12:00:00Z");
  db.exec(`INSERT INTO hostinger_accounts(id,label,token_ciphertext,token_hint,status,created_at) VALUES(1,'fixture',X'00','0000','ok',0);
    INSERT INTO mailboxes(id,account_id,order_id,remote_id,address,domain,status) VALUES(1,1,'o','r','mail@example.test','example.test','active');
    INSERT INTO model_providers(id,name,protocol,base_url,models_json,created_at) VALUES(1,'offline','openai','https://never.example.test','[]',0);
    INSERT INTO model_roles(role,provider_id,model_id,thinking) VALUES('mail_triage',1,'offline','off');
    UPDATE mail_triage_settings SET enabled=1,state='enabled',consent_provider_revision=1;
    INSERT INTO mail_triage_scope(mailbox_id,epoch,state,uid_validity,baseline_uid,effective_at) VALUES(1,1,'authorized','100',0,0);`);
  const options = { jitter: () => 0 }; const clock = () => now;
  const tuple = { providerId: 1, modelId: "offline", modelConfigRevision: 1, promptVersion: 1, ruleVersion: 1, schemaVersion: 1 };
  let q = createTriageQueue(db, clock, options); let uid = 0;
  function input(priority: "new" | "history" = "new"): JobRegistration {
    const id = randomUUID(); db.prepare("INSERT INTO mail_triage_sources(id,mailbox_id,source_hash,critical_headers_hash,observed_at) VALUES(?,1,?,?,?)").run(id,id,id,now);
    db.prepare("INSERT INTO mail_triage_source_aliases(mailbox_id,folder,uid_validity,uid,source_id) VALUES(1,'INBOX','100',?,?)").run(++uid,id);
    return { sourceId: id, sourceVersion: 1, tuple, contextVersion: `context:${id}`, generation: 1, configEpoch: 1, priority };
  }
  return { get db() { return db; }, get q() { return q; }, tuple, input, clock, setTime(n: number) { now = n; }, advance(n: number) { now += n; },
    secondConnection() { return openDb(path); },
    reopen() { db.close(); db = openDb(path); q = createTriageQueue(db, clock, options); return q; },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const state = (f: ReturnType<typeof fixture>, id: string) => f.db.prepare("SELECT * FROM mail_triage_jobs WHERE id=?").get(id)!;

test("B29 duplicate registration stays unique; reopen dispatches durable jobs without SSE", () => {
  const f = fixture(); try {
    const input = f.input(); const id = f.q.enqueue(input); assert.equal(f.q.enqueue(input), id);
    f.reopen(); assert.equal(f.q.peekPriority(), "new"); assert.equal(f.q.claim()!.jobId, id); assert.equal(f.q.claim(), null);
  } finally { f.close(); }
});

test("B32 exactly three committed permits; backoff and longer Retry-After release lease", () => {
  const f = fixture(); try {
    const id = f.q.enqueue(f.input()); let reserved = 0;
    for (const [seq, wait] of [[1, 45000], [2, 120000], [3, 0]]) {
      const lease = f.q.claim()!; assert.ok(lease); const permit = f.q.reserveAttempt(lease); reserved++;
      assert.equal(permit.fence.attemptSeq, seq); assert.equal(permit.deadlineAt, f.clock() + 60000);
      assert.throws(() => f.q.reserveAttempt(lease), /attempt|许可|lease/);
      f.q.retry(permit.fence, { code: "http_429", retryable: true, retryAfterMs: 45000 });
      assert.equal(state(f,id).lease_token, null);
      if (seq < 3) { f.advance(wait - 1); assert.equal(f.q.claim(), null); f.advance(1); }
    }
    assert.equal(reserved, 3); assert.equal(state(f,id).state, "failed"); f.advance(999999); f.q.recover(); assert.equal(f.q.claim(), null);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n, 3);
  } finally { f.close(); }
});

test("B40/B53 crash after reserve consumes unknown; no redispatch before original deadline plus 30s", () => {
  const f = fixture(); try {
    const id = f.q.enqueue(f.input()); const old = f.q.claim()!; const permit = f.q.reserveAttempt(old);
    f.reopen(); f.advance(89999); assert.equal(f.q.recover(), 0); assert.equal(f.q.claim(), null);
    f.advance(1); assert.equal(f.q.recover(), 1); const next = f.q.claim()!;
    assert.notEqual(next.leaseToken, old.leaseToken); assert.equal(f.q.renew(permit.fence), false);
    f.q.retry(permit.fence, { code: "timeout", retryable: true }); assert.equal(state(f,id).lease_token,next.leaseToken);
    assert.equal(f.q.reserveAttempt(next).fence.attemptSeq, 2);
    assert.equal(f.db.prepare("SELECT outcome FROM mail_triage_attempts WHERE attempt_seq=1").get()!.outcome, "unknown");
  } finally { f.close(); }
});

test("crash before reserve recovers without spending attempt; renewal extends only current live fence", () => {
  const f = fixture(); try {
    f.q.enqueue(f.input()); const lease = f.q.claim()!; f.advance(90000); assert.equal(f.q.recover(), 1);
    const next = f.q.claim()!; const permit = f.q.reserveAttempt(next); f.advance(15000); assert.equal(f.q.renew(permit.fence),true);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,1);
    assert.notEqual(lease.leaseToken,next.leaseToken);
  } finally { f.close(); }
});

test("B58 UTC day: 500th actual attempt pauses; midnight restores budget without reviving cancellation", () => {
  const f = fixture(); try {
    f.setTime(Date.parse("2026-10-16T23:59:59Z"));
    // 499 durable consumed requests, including anonymized history, count against the workspace day.
    const insert = f.db.prepare("INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome) VALUES(?,NULL,1,'2026-10-16',0,0,'unknown')");
    for(let n=0;n<499;n++) insert.run(randomUUID());
    const id = f.q.enqueue(f.input()); const permit = f.q.reserveAttempt(f.q.claim()!);
    assert.equal(f.db.prepare("SELECT state FROM mail_triage_settings").get()!.state,"paused_budget");
    f.q.retry(permit.fence,{ code:"timeout", retryable:true }); const next = f.q.enqueue(f.input());
    assert.equal(f.q.claim(), null); f.advance(1000); f.q.recover(); assert.equal(f.q.reserveAttempt(f.q.claim()!).fence.attemptSeq,1);
    assert.equal(state(f,next).state,"running"); assert.equal(state(f,id).attempt_seq,1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts WHERE budget_day='2026-10-17'").get()!.n,1);
  } finally { f.close(); }
});

test("B60 cancelled jobs remain terminal after restart and deadline", () => {
  const f = fixture(); try {
    const input=f.input(); const id=f.q.enqueue(input); const permit=f.q.reserveAttempt(f.q.claim()!);
    f.q.cancel([input.sourceId],"revoked"); f.reopen(); f.advance(999999); assert.equal(f.q.recover(),0);
    assert.equal(f.q.claim(),null); assert.equal(state(f,id).state,"cancelled"); assert.equal(f.q.renew(permit.fence),false);
  } finally { f.close(); }
});

test("pending outbox requires atomic context preparation without spending attempt; attempted context cannot change", () => {
  const f=fixture(); try {
    const input=f.input(); input.contextVersion=`pending-source:${input.sourceId}:1`; const id=f.q.enqueue(input); const lease=f.q.claim()!;
    assert.throws(()=>f.q.reserveAttempt(lease),/context|上下文/);
    const prepared=f.q.prepareContext(lease,{contextVersion:"real-hash",manualVersion:4,tuple:f.tuple})!;
    assert.equal(state(f,id).attempt_seq,0); assert.throws(()=>f.q.reserveAttempt(lease),/lease|fence|租约/);
    const permit=f.q.reserveAttempt(prepared); assert.equal(permit.fence.contextVersion,"real-hash"); assert.equal(permit.fence.manualVersion,4);
    assert.throws(()=>f.q.prepareContext({...prepared,attemptSeq:permit.fence.attemptSeq},{contextVersion:"different",manualVersion:4,tuple:f.tuple}),/attempt|尝试/);
  } finally { f.close(); }
});

test("context unique collision cancels only unattempted placeholder, returns null, preserves canonical job",()=>{
  const f=fixture(); try {
    const input=f.input(); const id=f.q.enqueue(input);
    const pending=f.q.enqueue({...input,contextVersion:`pending-source:${input.sourceId}:1`});
    f.db.prepare("UPDATE mail_triage_jobs SET state='succeeded' WHERE id=?").run(id);
    const lease=f.q.claim()!; assert.equal(lease.jobId,pending);
    assert.equal(f.q.prepareContext(lease,{contextVersion:input.contextVersion,manualVersion:0,tuple:f.tuple}),null);
    assert.equal(state(f,pending).state,"cancelled"); assert.equal(state(f,id).state,"succeeded");
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,0);
  } finally { f.close(); }
});

for(const mutation of ["UPDATE mail_triage_settings SET state='initializing'", "UPDATE mail_triage_settings SET enabled=0", "UPDATE mail_triage_settings SET config_epoch=2", "UPDATE mail_triage_scope SET state='revoked'", "UPDATE mail_triage_scope SET uid_validity=NULL", "UPDATE mail_triage_scope SET effective_at=NULL", "UPDATE mail_triage_sources SET source_version=2", "INSERT INTO abandoned_domains(domain,abandoned_at) VALUES('example.test',0)"])
  test(`dispatch and reserve recheck authorization: ${mutation}`,()=>{
    const f=fixture(); try {
      f.q.enqueue(f.input()); const lease=f.q.claim()!; f.db.exec(mutation); assert.throws(()=>f.q.reserveAttempt(lease));
      f.advance(999999); f.q.recover(); assert.equal(f.q.claim(),null); assert.equal(f.q.peekPriority(),null);
      assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,0);
    } finally { f.close(); }
  });

for(const [code,want] of [["http_401","blocked_config"],["unsupported_protocol","blocked_config"],["missing_purpose","blocked_config"],["invalid_json","failed"],["invalid_evidence","needs_review"],["bad_request","failed"]])
  test(`nonretryable ${code} settles once as ${want} even if caller requests retry`,()=>{
    const f=fixture(); try {
      const id=f.q.enqueue(f.input()); const permit=f.q.reserveAttempt(f.q.claim()!); f.q.retry(permit.fence,{code:code!,retryable:true});
      f.advance(999999); f.q.recover(); assert.equal(state(f,id).state,want); assert.equal(f.q.claim(),null);
    } finally { f.close(); }
  });

test("dual DB connections cannot claim parallel workspace work or reserve same lease twice; failed SQL reservation rolls back",()=>{
  const f=fixture(); try {
    const a=f.q.enqueue(f.input("history")); const b=f.q.enqueue(f.input());
    const lease=f.q.claim()!; assert.equal(lease.jobId,b); assert.notEqual(lease.jobId,a);
    const other=f.secondConnection(); const q2=createTriageQueue(other,f.clock); assert.equal(q2.claim(),null);
    f.db.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON mail_triage_attempts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.throws(()=>f.q.reserveAttempt(lease),/fixture failure/); assert.equal(state(f,b).attempt_seq,0);
    f.db.exec("DROP TRIGGER fail_attempt"); f.q.reserveAttempt(lease); assert.throws(()=>q2.reserveAttempt(lease)); other.close();
  } finally { f.close(); }
});

test("RF2/RF5 scheduler new work wins, equal-priority workspaces rotate; duplicate release and abort never leak",async()=>{
  const s=createTriageScheduler(1); const signal=new AbortController().signal; const first=await s.acquire("A","history",signal);
  const order:string[]=[];
  const a=s.acquire("A","history",signal).then(release=>{order.push("A");return release;});
  const b=s.acquire("B","new",signal).then(release=>{order.push("B");return release;});
  first(); first(); const rb=await b; assert.deepEqual(order,["B"]); rb(); (await a)();
  const held=await s.acquire("A","new",signal); const ab=new AbortController(); const pending=s.acquire("B","new",ab.signal);
  ab.abort(); await assert.rejects(pending,{name:"AbortError"}); held();
  const activeController=new AbortController(); await s.acquire("A","new",activeController.signal); activeController.abort();
  (await s.acquire("A","new",signal))(); s.close(); await assert.rejects(s.acquire("C","new",signal));
});

test("RF2 global limit4 and workspace limit1 hold under queued interleavings",async()=>{
  const s=createTriageScheduler(); const signal=new AbortController().signal; let active=0,maxGlobal=0;const counts=new Map<string,number>();
  let maxWorkspace=0; const jobs=Array.from({length:24},(_,i)=>{const key=String(i%6); return s.acquire(key,i%3===0?"new":"history",signal).then(async release=>{
    active++; counts.set(key,(counts.get(key)??0)+1);maxGlobal=Math.max(maxGlobal,active);maxWorkspace=Math.max(maxWorkspace,counts.get(key)!);
    await Promise.resolve(); counts.set(key,counts.get(key)!-1);active--;release();
  });}); await Promise.all(jobs); assert.ok(maxGlobal<=4);assert.equal(maxGlobal,4);assert.equal(maxWorkspace,1);s.close();
});


test("B58 500 real SQL permits pause the workspace and a 501st never reserves",()=>{
  const f=fixture(); try {
    for(let n=0;n<500;n++){
      f.q.enqueue(f.input()); const lease=f.q.claim()!; assert.ok(lease,`claim ${n+1}`);
      const permit=f.q.reserveAttempt(lease); f.q.retry(permit.fence,{code:"bad_request",retryable:false});
    }
    f.q.enqueue(f.input()); assert.equal(f.q.claim(),null);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM mail_triage_attempts").get()!.n,500);
    assert.equal(f.db.prepare("SELECT state FROM mail_triage_settings").get()!.state,"paused_budget");
  } finally { f.close(); }
});

for(const mutation of ["UPDATE mail_triage_settings SET enabled=0", "UPDATE mail_triage_settings SET state='initializing'", "UPDATE mail_triage_settings SET config_epoch=2", "UPDATE mail_triage_scope SET state='revoked'", "UPDATE model_providers SET config_revision=2"])
  test(`UTC budget recovery cannot bypass changed authorization: ${mutation}`,()=>{
    const f=fixture(); try {
      f.db.exec("UPDATE mail_triage_settings SET daily_attempt_limit=1"); f.setTime(Date.parse("2026-10-16T23:59:59Z"));
      f.q.enqueue(f.input());const permit=f.q.reserveAttempt(f.q.claim()!);f.q.retry(permit.fence,{code:"timeout",retryable:true});
      f.db.exec(mutation); f.advance(100000);f.q.recover();assert.equal(f.q.claim(),null);assert.equal(f.q.peekPriority(),null);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM mail_triage_attempts").get()!.n,1);
    } finally { f.close(); }
  });

test("recovery honors persisted deadline+30 even when that exceeds expired lease; third unknown becomes terminal",()=>{
  const f=fixture();try {
    const id=f.q.enqueue(f.input());let lease=f.q.claim()!;f.q.reserveAttempt(lease);
    f.db.prepare("UPDATE mail_triage_attempts SET deadline_at=?").run(f.clock()+120000);
    f.advance(90000);assert.equal(f.q.recover(),0);f.advance(59999);assert.equal(f.q.recover(),0);
    f.advance(1);assert.equal(f.q.recover(),1);lease=f.q.claim()!;f.q.reserveAttempt(lease);
    f.advance(90000);f.q.recover();lease=f.q.claim()!;f.q.reserveAttempt(lease);
    f.advance(90000);f.q.recover();assert.equal(state(f,id).state,"failed");assert.equal(f.q.claim(),null);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts WHERE outcome='unknown'").get()!.n,3);
  }finally{f.close();}
});

test("budget overshoot check commits pause but never attempt; disabled budget state is not auto-enabled",()=>{
  const f=fixture();try {
    f.db.exec("UPDATE mail_triage_settings SET daily_attempt_limit=1"); f.q.enqueue(f.input());const lease=f.q.claim()!;
    f.db.prepare("INSERT INTO mail_triage_attempts(id,job_id,attempt_seq,budget_day,reserved_at,deadline_at,outcome) VALUES(?,NULL,1,'2026-10-16',0,0,'unknown')").run(randomUUID());
    assert.throws(()=>f.q.reserveAttempt(lease),/预算/);assert.equal(state(f,lease.jobId).state,"paused_budget");
    f.db.exec("UPDATE mail_triage_settings SET enabled=0");f.advance(86400000);f.q.recover();assert.equal(f.q.claim(),null);
  }finally{f.close();}
});

test("synchronous mailbox runtime guard blocks claim and rechecks reserve; async guards are forbidden",()=>{
  const f=fixture();try {
    const id=f.q.enqueue(f.input());let available=false;
    const q=createTriageQueue(f.db,f.clock,{isMailboxAvailable:()=>available});assert.equal(q.claim(),null);
    available=true;const lease=q.claim()!;assert.equal(lease.jobId,id);available=false;assert.throws(()=>q.reserveAttempt(lease));
    assert.throws(()=>createTriageQueue(f.db,f.clock,{isMailboxAvailable:(async()=>true) as unknown as ()=>boolean}),/同步/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,0);
  }finally{f.close();}
});

test("retry jitter clamps to [0,1000] and raw failure text is never persisted",()=>{
  const f=fixture();try {
    f.q.enqueue(f.input());const q=createTriageQueue(f.db,f.clock,{jitter:()=>9000});const permit=q.reserveAttempt(q.claim()!);
    q.retry(permit.fence,{code:"network_error",retryable:true});assert.equal(state(f,permit.fence.jobId).next_attempt_at,f.clock()+31000);
    f.advance(31000);const next=q.reserveAttempt(q.claim()!);q.retry(next.fence,{code:"raw secret response https://mail.example.test",retryable:true});
    assert.equal(state(f,next.fence.jobId).last_error,"request_failed");assert.equal(state(f,next.fence.jobId).state,"failed");
  }finally{f.close();}
});

test("same-priority workspaces round-robin rather than draining a workspace backlog; close rejects waiters",async()=>{
  const s=createTriageScheduler(1);const signal=new AbortController().signal;const held=await s.acquire("A","new",signal);const order:string[]=[];
  const request=(key:string)=>s.acquire(key,"new",signal).then(release=>{order.push(key);return release;});
  const a1=request("A"),a2=request("A"),b=request("B"),c=request("C");held();(await b)();(await c)();(await a1)();(await a2)();
  assert.deepEqual(order,["B","C","A","A"]);
  const active=await s.acquire("A","history",signal);const pending=s.acquire("B","new",signal);s.close();await assert.rejects(pending);active();s.close();
});

test("literal http_503 is a transient 5xx and retries without retaining server response details",()=>{
  const f=fixture();try {
    const id=f.q.enqueue(f.input());const permit=f.q.reserveAttempt(f.q.claim()!);
    f.q.retry(permit.fence,{code:"http_503",retryable:true,retryAfterMs:180000});
    assert.equal(state(f,id).state,"retry_wait");assert.equal(state(f,id).next_attempt_at,f.clock()+180000);
    assert.equal(state(f,id).last_error,"http_5xx");
  }finally{f.close();}
});

test("post-insert reservation failure rolls back attempt row and sequence atomically",()=>{
  const f=fixture();try {
    const id=f.q.enqueue(f.input());const lease=f.q.claim()!;
    f.db.exec("CREATE TRIGGER fail_sequence AFTER UPDATE OF attempt_seq ON mail_triage_jobs WHEN NEW.attempt_seq>0 BEGIN SELECT RAISE(ABORT,'sequence failure'); END;");
    assert.throws(()=>f.q.reserveAttempt(lease),/sequence failure/);
    assert.equal(state(f,id).attempt_seq,0);assert.equal(state(f,id).lease_token,lease.leaseToken);
    assert.equal(f.db.prepare("SELECT count(*) n FROM mail_triage_attempts").get()!.n,0);
    f.db.exec("DROP TRIGGER fail_sequence");assert.equal(f.q.reserveAttempt(lease).fence.attemptSeq,1);
  }finally{f.close();}
});

for(const mutation of ["UPDATE mail_triage_jobs SET manual_version=manual_version+1", "UPDATE mail_triage_jobs SET context_version='changed'", "UPDATE mail_triage_jobs SET attempt_seq=attempt_seq+1", "UPDATE mail_triage_jobs SET state='succeeded'", "UPDATE mail_triage_settings SET model_config_revision=2", "UPDATE model_roles SET model_id='different'"])
  test(`stale fence cannot renew or settle after ${mutation}`,()=>{
    const f=fixture();try {
      const id=f.q.enqueue(f.input());const permit=f.q.reserveAttempt(f.q.claim()!);f.db.exec(mutation);
      assert.equal(f.q.renew(permit.fence),false);f.q.retry(permit.fence,{code:"timeout",retryable:true});
      assert.equal(f.db.prepare("SELECT outcome FROM mail_triage_attempts").get()!.outcome,"reserved");
      assert.notEqual(state(f,id).state,"retry_wait");
    }finally{f.close();}
  });

test("history authorization may precede new-mail watermark but never an effective-at time still in the future",()=>{
  const f=fixture();try {
    const input=f.input("history");f.q.enqueue(input);
    f.db.prepare("UPDATE mail_triage_scope SET baseline_uid=100,effective_at=?").run(f.clock()+1);
    assert.equal(f.q.claim(),null);f.advance(1);assert.equal(f.q.claim()!.sourceId,input.sourceId);
  }finally{f.close();}
});
