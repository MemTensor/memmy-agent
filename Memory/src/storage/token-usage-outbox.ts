import type Database from "better-sqlite3";

export interface TokenUsageOutboxRecord {
  eventId: string;
  payloadJson: string;
}

export class TokenUsageOutbox {
  constructor(private readonly db: Database.Database) {}

  enqueue(eventId: string, payloadJson: string): void {
    this.db.prepare(
      `INSERT INTO token_usage_outbox (event_id, payload_json) VALUES (?, ?)`
    ).run(eventId, payloadJson);
  }

  listNext(limit: number): TokenUsageOutboxRecord[] {
    const rows = this.db.prepare(
      `SELECT event_id, payload_json
       FROM token_usage_outbox
       ORDER BY sequence ASC
       LIMIT ?`
    ).all(Math.max(1, Math.trunc(limit))) as Array<{ event_id: string; payload_json: string }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      payloadJson: row.payload_json
    }));
  }

  deleteByEventId(eventId: string): void {
    this.db.prepare(`DELETE FROM token_usage_outbox WHERE event_id = ?`).run(eventId);
  }

  hasPending(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM token_usage_outbox LIMIT 1`).get());
  }
}
