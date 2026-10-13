import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { GraphEdge, SymbolHit } from "./types.js";

const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): readonly Record<string, unknown>[];
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncConstructor = new (filename: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDb;

function openDatabase(filename: string, readOnly = false): SqliteDb {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
  return new DatabaseSync(filename, { readOnly, timeout: 5000 });
}

export interface FileRow {
  readonly path: string;
  readonly hash: string;
  readonly mtimeMs: number;
  readonly bytes: number;
  readonly language: string;
}

export interface ImportRow {
  readonly path: string;
  readonly specifier: string;
}

export interface StoreSnapshot {
  readonly generation: number;
  readonly state: string;
  readonly freshness: string;
  readonly snapshot: string;
  readonly lastError: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  bytes INTEGER NOT NULL,
  language TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_path_idx ON symbols(path);
CREATE TABLE IF NOT EXISTS imports (
  path TEXT NOT NULL,
  specifier TEXT NOT NULL,
  PRIMARY KEY(path, specifier)
);
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY(source_id, target_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id);
`;

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export class RelationStore {
  readonly dbPath: string;
  private writer: SqliteDb | null = null;
  private readonly readers: SqliteDb[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();
  private readCursor = 0;

  constructor(dbPath: string, private readonly readPoolSize = 2) {
    this.dbPath = dbPath;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  async open(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      this.writer = openDatabase(this.dbPath);
      this.writer.exec(SCHEMA);
      for (let index = 0; index < Math.max(1, this.readPoolSize); index += 1) {
        this.readers.push(openDatabase(this.dbPath, true));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    for (const reader of this.readers.splice(0)) {
      try { reader.close(); } catch { /* preserve the original store error */ }
    }
    try { this.writer?.close(); } catch { /* preserve the original store error */ }
    this.writer = null;
  }

  private requireWriter(): SqliteDb {
    if (!this.writer) throw new Error("STORE_NOT_OPEN");
    return this.writer;
  }

  private requireReader(): SqliteDb {
    if (this.readers.length === 0) return this.requireWriter();
    const reader = this.readers[this.readCursor % this.readers.length];
    this.readCursor += 1;
    return reader;
  }

  write<T>(fn: (db: SqliteDb) => T): Promise<T> {
    const run = this.writeTail.then(() => fn(this.requireWriter()));
    this.writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  read<T>(fn: (db: SqliteDb) => T): T {
    return fn(this.requireReader());
  }

  transaction<T>(fn: (db: SqliteDb) => T): Promise<T> {
    return this.write((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original */ }
        throw error;
      }
    });
  }

  snapshot(): StoreSnapshot {
    return this.read((db) => {
      const get = (key: string, fallback: string): string => {
        const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
        return typeof row?.value === "string" ? row.value : fallback;
      };
      return {
        generation: Number(get("generation", "0")),
        state: get("state", "absent"),
        freshness: get("freshness", "unknown"),
        snapshot: get("snapshot", ""),
        lastError: get("lastError", "") || null,
      };
    });
  }

  setMeta(db: SqliteDb, values: Readonly<Record<string, string | number | null>>): void {
    const statement = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [key, value] of Object.entries(values)) statement.run(key, value === null ? "" : String(value));
  }

  listFiles(): readonly FileRow[] {
    return this.read((db) => db.prepare("SELECT path, hash, mtime_ms as mtimeMs, bytes, language FROM files ORDER BY path").all().map((row) => ({ path: String(row.path), hash: String(row.hash), mtimeMs: asNumber(row.mtimeMs), bytes: asNumber(row.bytes), language: String(row.language) })));
  }

  listSymbols(): readonly SymbolHit[] {
    return this.read((db) => db.prepare("SELECT id, name, kind, path, start_line as startLine, end_line as endLine FROM symbols ORDER BY path, start_line, name").all().map((row) => ({ id: String(row.id), name: String(row.name), kind: String(row.kind), path: String(row.path), startLine: asNumber(row.startLine), endLine: asNumber(row.endLine) })));
  }

  listImports(): readonly ImportRow[] {
    return this.read((db) => db.prepare("SELECT path, specifier FROM imports ORDER BY path, specifier").all().map((row) => ({ path: String(row.path), specifier: String(row.specifier) })));
  }

  listEdges(): readonly GraphEdge[] {
    return this.read((db) => db.prepare("SELECT source_id as sourceId, target_id as targetId, kind FROM edges ORDER BY source_id, target_id, kind").all().map((row) => ({ sourceId: String(row.sourceId), targetId: String(row.targetId), kind: String(row.kind) as GraphEdge["kind"] })));
  }

  count(table: "files" | "symbols" | "edges"): number {
    return this.read((db) => asNumber(db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get()?.count));
  }

  indexBytes(): number {
    try { return require("node:fs").statSync(this.dbPath).size as number; } catch { return 0; }
  }

  replaceAll(
    db: SqliteDb,
    files: readonly FileRow[],
    symbols: readonly SymbolHit[],
    imports: readonly ImportRow[],
    edges: readonly GraphEdge[],
    meta: Readonly<Record<string, string | number | null>>,
  ): void {
    db.exec("DELETE FROM files; DELETE FROM symbols; DELETE FROM imports; DELETE FROM edges;");
    const fileInsert = db.prepare("INSERT INTO files(path, hash, mtime_ms, bytes, language) VALUES(?, ?, ?, ?, ?)");
    for (const file of files) fileInsert.run(file.path, file.hash, file.mtimeMs, file.bytes, file.language);
    const symbolInsert = db.prepare("INSERT INTO symbols(id, name, kind, path, start_line, end_line) VALUES(?, ?, ?, ?, ?, ?)");
    for (const symbol of symbols) symbolInsert.run(symbol.id, symbol.name, symbol.kind, symbol.path, symbol.startLine, symbol.endLine);
    const importInsert = db.prepare("INSERT INTO imports(path, specifier) VALUES(?, ?)");
    for (const item of imports) importInsert.run(item.path, item.specifier);
    const edgeInsert = db.prepare("INSERT INTO edges(source_id, target_id, kind) VALUES(?, ?, ?)");
    for (const edge of edges) edgeInsert.run(edge.sourceId, edge.targetId, edge.kind);
    this.setMeta(db, meta);
  }

  replacePath(db: SqliteDb, pathName: string, file: FileRow | null, symbols: readonly SymbolHit[], imports: readonly ImportRow[]): void {
    db.prepare("DELETE FROM files WHERE path = ?").run(pathName);
    db.prepare("DELETE FROM symbols WHERE path = ?").run(pathName);
    db.prepare("DELETE FROM imports WHERE path = ?").run(pathName);
    db.prepare("DELETE FROM edges WHERE substr(source_id, 1, length(?) + 2) = ? || '::' OR substr(target_id, 1, length(?) + 2) = ? || '::'").run(pathName, pathName, pathName, pathName);
    if (file) db.prepare("INSERT INTO files(path, hash, mtime_ms, bytes, language) VALUES(?, ?, ?, ?, ?)").run(file.path, file.hash, file.mtimeMs, file.bytes, file.language);
    const symbolInsert = db.prepare("INSERT INTO symbols(id, name, kind, path, start_line, end_line) VALUES(?, ?, ?, ?, ?, ?)");
    if (file) symbolInsert.run(`${pathName}::module`, path.posix.basename(pathName), "module", pathName, 1, 1);
    for (const symbol of symbols) symbolInsert.run(symbol.id, symbol.name, symbol.kind, symbol.path, symbol.startLine, symbol.endLine);
    const importInsert = db.prepare("INSERT INTO imports(path, specifier) VALUES(?, ?)");
    for (const item of imports) importInsert.run(item.path, item.specifier);
  }

  replaceEdges(db: SqliteDb, edges: readonly GraphEdge[]): void {
    db.exec("DELETE FROM edges;");
    const insert = db.prepare("INSERT INTO edges(source_id, target_id, kind) VALUES(?, ?, ?)");
    for (const edge of edges) insert.run(edge.sourceId, edge.targetId, edge.kind);
  }
}

export type { SqliteDb };
