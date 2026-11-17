import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class SwarmState {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'swarm.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        run_id TEXT REFERENCES runs(id), id TEXT, data TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT REFERENCES runs(id), seq INTEGER, at TEXT NOT NULL,
        kind TEXT NOT NULL, member_id TEXT, data TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        thread_id TEXT, id TEXT, response TEXT NOT NULL, PRIMARY KEY (thread_id, id)
      );
    `);
  }

  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  runs() {
    return this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all()
      .map(row => JSON.parse(row.data));
  }

  members(runId) {
    return this.db.prepare('SELECT data FROM members WHERE run_id = ? ORDER BY rowid').all(runId)
      .map(row => JSON.parse(row.data));
  }

  events(runId) {
    return this.db.prepare(`
      SELECT seq, at, kind, member_id AS memberId, data
      FROM events WHERE run_id = ? ORDER BY seq
    `).all(runId).map(row => ({ ...row, data: JSON.parse(row.data) }));
  }

  saveRun(run) {
    this.db.prepare(`
      INSERT INTO runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(run.id, JSON.stringify(run));
  }

  saveMember(runId, member) {
    this.db.prepare(`
      INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(run_id, id) DO UPDATE SET data = excluded.data
    `).run(runId, member.id, JSON.stringify(member));
  }

  append(runId, kind, memberId, data = {}, at = new Date().toISOString()) {
    const { seq } = this.db.prepare(`
      INSERT INTO events (run_id, seq, at, kind, member_id, data)
      SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM events WHERE run_id = ?
      RETURNING seq
    `).get(runId, at, kind, memberId ?? null, JSON.stringify(data), runId);
    return { seq, at, kind, memberId, data };
  }

  toolResult(threadId, callId) {
    if (!callId) return undefined;
    const row = this.db.prepare('SELECT response FROM tool_calls WHERE thread_id = ? AND id = ?')
      .get(threadId, callId);
    return row && JSON.parse(row.response);
  }

  saveToolResult(threadId, callId, result) {
    if (callId) {
      this.db.prepare('INSERT OR IGNORE INTO tool_calls VALUES (?, ?, ?)')
        .run(threadId, callId, JSON.stringify(result));
    }
  }

  close() {
    this.db.close();
  }
}
