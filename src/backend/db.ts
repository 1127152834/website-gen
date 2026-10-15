import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunEventKind } from "../shared/protocol.ts";
import { MIGRATIONS } from "./migrations.ts";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function migrate(db: DatabaseSync): void {
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

interface EventRow {
  seq: number;
  ts: number;
  batch_id: string | null;
  site_id: string | null;
  kind: RunEventKind;
  payload_json: string;
}

const toEvent = (r: EventRow): RunEvent => ({
  seq: r.seq,
  ts: r.ts,
  batchId: r.batch_id,
  siteId: r.site_id,
  kind: r.kind,
  payload: JSON.parse(r.payload_json),
});

export function appendEvent(
  db: DatabaseSync,
  e: { batchId?: string | null; siteId: string | null; kind: RunEventKind; payload: Record<string, unknown> },
): RunEvent {
  const row = db
    .prepare("INSERT INTO run_events (ts, batch_id, site_id, kind, payload_json) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .get(Date.now(), e.batchId ?? null, e.siteId, e.kind, JSON.stringify(e.payload)) as unknown as EventRow;
  return toEvent(row);
}

export function eventsSince(db: DatabaseSync, afterSeq: number, limit = 1000): RunEvent[] {
  const rows = db.prepare("SELECT * FROM run_events WHERE seq > ? ORDER BY seq LIMIT ?").all(afterSeq, limit);
  return (rows as unknown as EventRow[]).map(toEvent);
}
