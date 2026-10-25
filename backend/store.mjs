import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const decode = (value) => value ? JSON.parse(typeof value === 'string' ? value : gunzipSync(value).toString()) : null;

export class LeaseError extends Error {}

export class Store {
  constructor(path, { now = Date.now } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.now = now;
    this.owner = randomUUID();
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (
        key TEXT PRIMARY KEY, context TEXT NOT NULL, scope TEXT NOT NULL,
        result TEXT, hash TEXT, checked_at INTEGER, attempted_at INTEGER,
        next_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS results_schedule ON results (context, next_at);
      CREATE INDEX IF NOT EXISTS results_kind_schedule ON results (json_extract(scope, '$.kind'), next_at, context);
      CREATE TABLE IF NOT EXISTS context_versions (context TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS r2_objects (
        target TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (target, key)
      );
    `);
  }

  getMeta(key, fallback = null) {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  claim() {
    const row = this.db.query(`INSERT INTO lease VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE lease.owner = excluded.owner OR lease.expires_at <= ? RETURNING owner`).get(this.owner, this.now() + 60000, this.now());
    if (!row) throw new LeaseError('Outro coletor está ativo neste banco.');
  }

  seed(context, scopes) {
    const insert = this.db.query('INSERT INTO results (key, context, scope) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET scope = excluded.scope');
    this.db.transaction(() => {
      const keys = new Set(scopes.map((scope) => `${context}:${scope.uf}:${scope.tse || '-'}`));
      for (const row of this.db.query('SELECT key FROM results WHERE context = ?').all(context)) {
        if (!keys.has(row.key)) this.db.query('DELETE FROM results WHERE key = ?').run(row.key);
      }
      for (const scope of scopes) insert.run(`${context}:${scope.uf}:${scope.tse || '-'}`, context, JSON.stringify(scope));
      this.touch(context);
    })();
  }

  record(key) {
    const row = this.db.query('SELECT * FROM results WHERE key = ?').get(key);
    return row ? { ...row, scope: JSON.parse(row.scope), result: decode(row.result) } : null;
  }

  due(context, regionalOnly = false) {
    return this.db.query(`SELECT key, scope FROM results WHERE context = ? AND next_at <= ?
      ${regionalOnly ? "AND json_extract(scope, '$.kind') IN ('country', 'state')" : ''}
      ORDER BY CASE WHEN json_extract(scope, '$.kind') = 'municipality' THEN 1 ELSE 0 END,
      COALESCE(checked_at, 0), next_at, key`).all(context, this.now())
      .map((row) => ({ key: row.key, scope: JSON.parse(row.scope) }));
  }

  success(key, result, nextAt) {
    const serialized = JSON.stringify(result);
    const hash = createHash('sha256').update(serialized).digest('hex');
    const previous = this.db.query('SELECT context, hash FROM results WHERE key = ?').get(key);
    this.db.query(`UPDATE results SET result = ?, hash = ?, checked_at = ?, attempted_at = ?, next_at = ?, failures = 0, error = NULL WHERE key = ?`)
      .run(gzipSync(serialized, { level: 1 }), hash, this.now(), this.now(), nextAt, key);
    if (previous && previous.hash !== hash) this.touch(previous.context);
  }

  failure(key, error, nextAt) {
    this.db.query('UPDATE results SET attempted_at = ?, next_at = ?, failures = failures + 1, error = ? WHERE key = ?')
      .run(this.now(), nextAt, error, key);
  }

  touch(context) {
    this.db.query('INSERT INTO context_versions VALUES (?, 1) ON CONFLICT(context) DO UPDATE SET version = version + 1').run(context);
  }

  revision(context) { return this.db.query('SELECT version FROM context_versions WHERE context = ?').get(context)?.version || 0; }

  publicationKeys(prefix) {
    return new Set(this.db.query('SELECT value FROM meta WHERE key GLOB ?').all(`${prefix}*`).flatMap((row) => JSON.parse(row.value).objectKeys || []));
  }

  municipalityRecord(context, ibge) {
    const row = this.db.query("SELECT key FROM results WHERE context = ? AND json_extract(scope, '$.ibge') = ? LIMIT 1").get(context, ibge);
    return row ? this.record(row.key) : null;
  }

  stateRecord(context) {
    const row = this.db.query("SELECT key FROM results WHERE context = ? AND json_extract(scope, '$.kind') = 'state' LIMIT 1").get(context);
    if (!row) return null;
    const value = this.record(row.key);
    return { scope: value.scope, result: value.result, checkedAt: value.checked_at, attemptedAt: value.attempted_at, nextAt: value.next_at, error: value.error };
  }

  snapshot(context) {
    if (!context) return { configured: 0, available: 0, failed: 0, oldestCheckedAt: null, lastCheckedAt: null };
    const row = this.db.query(`SELECT COUNT(*) AS configured, COUNT(result) AS available,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
      MIN(checked_at) AS oldestCheckedAt, MAX(checked_at) AS lastCheckedAt FROM results WHERE context = ?`).get(context);
    return { ...row, failed: row.failed || 0 };
  }

  exportRecords(context, compact = false) {
    const rows = [];
    for (const row of this.db.query('SELECT scope, result, checked_at, attempted_at, next_at, error FROM results WHERE context = ? ORDER BY key').iterate(context)) {
      const scope = JSON.parse(row.scope);
      let result = decode(row.result);
      if (compact && scope.kind === 'municipality' && result?.candidates?.length > 20) result = { ...result,
        candidateCount: result.candidates.length, candidatesTruncated: true, candidates: result.candidates.slice(0, 2) };
      rows.push({ scope, result, checkedAt: row.checked_at, attemptedAt: row.attempted_at, nextAt: row.next_at, error: row.error });
    }
    return rows;
  }

  dueContexts(contexts, regionalOnly = false, limit = 500) {
    if (!contexts.length) return [];
    return this.db.query(`SELECT key, context, scope FROM (
      SELECT key, context, scope, checked_at,
        CASE WHEN json_extract(scope, '$.kind') = 'country' THEN 0 WHEN json_extract(scope, '$.kind') = 'state' THEN 1 ELSE 2 END AS priority,
        ROW_NUMBER() OVER (PARTITION BY context ORDER BY COALESCE(checked_at, 0), next_at, key) AS position
      FROM results WHERE context IN (SELECT value FROM json_each(?)) AND next_at <= ?
      ${regionalOnly ? "AND json_extract(scope, '$.kind') IN ('country', 'state')" : ''}
    ) ORDER BY priority, position, COALESCE(checked_at, 0), key LIMIT ?`).all(JSON.stringify(contexts), this.now(), limit)
      .map((row) => ({ ...row, scope: JSON.parse(row.scope) }));
  }

  snapshotContexts(contexts) {
    if (!contexts.length) return { ...this.snapshot(null), municipalities: 0, states: 0 };
    const row = this.db.query(`SELECT COUNT(*) AS configured, COUNT(result) AS available,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed, MIN(checked_at) AS oldestCheckedAt,
      MAX(checked_at) AS lastCheckedAt,
      COUNT(DISTINCT CASE WHEN json_extract(scope, '$.kind') = 'municipality' THEN json_extract(scope, '$.ibge') END) AS municipalities,
      COUNT(DISTINCT CASE WHEN json_extract(scope, '$.kind') = 'state' THEN json_extract(scope, '$.uf') END) AS states
      FROM results WHERE context IN (SELECT value FROM json_each(?))`).get(JSON.stringify(contexts));
    return { ...row, failed: row.failed || 0 };
  }

  uploaded(target, key) {
    return Boolean(this.db.query('SELECT 1 FROM r2_objects WHERE target = ? AND key = ?').get(target, key));
  }

  rememberUpload(target, key) {
    this.db.query('INSERT OR IGNORE INTO r2_objects VALUES (?, ?, ?)').run(target, key, this.now());
  }

  retiredObjects(target, before, protectedKeys) {
    return this.db.query('SELECT key FROM r2_objects WHERE target = ? AND created_at < ? ORDER BY created_at').all(target, before)
      .map((row) => row.key).filter((key) => !protectedKeys.has(key)).slice(0, 20);
  }

  forgetUpload(target, key) {
    this.db.query('DELETE FROM r2_objects WHERE target = ? AND key = ?').run(target, key);
  }

  close() {
    this.db.query('DELETE FROM lease WHERE owner = ?').run(this.owner);
    this.db.close();
  }
}
