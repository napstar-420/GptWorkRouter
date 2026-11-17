// Relay storage: one SQLite file (node:sqlite). Accounts, the allowlist, machines (public keys
// only), pairing codes, generated secrets, and oidc-provider's records. Never task content.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = () => Math.floor(Date.now() / 1000);

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "relay.db");
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS allow (email TEXT PRIMARY KEY, added_at INTEGER);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at INTEGER, disabled INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, account_id TEXT UNIQUE, name TEXT, os TEXT, bridge_version TEXT,
      public_key TEXT, created_at INTEGER, revoke_pending INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS pairings (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE, public_key TEXT, name TEXT, os TEXT,
      bridge_version TEXT, expires_at INTEGER, status TEXT, account_id TEXT, machine_id TEXT);
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS oidc (model TEXT, id TEXT, payload TEXT, grant_id TEXT, user_code TEXT, uid TEXT, account_id TEXT,
      expires_at INTEGER, PRIMARY KEY (model, id));
    CREATE INDEX IF NOT EXISTS oidc_grant ON oidc (grant_id);
    CREATE INDEX IF NOT EXISTS oidc_uid ON oidc (uid);
    CREATE INDEX IF NOT EXISTS oidc_account ON oidc (model, account_id);
  `);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    this.onGrantChange = () => {}; // set by the server: (accountId) => void
  }

  q(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  one(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }

  // A secret made on first start and kept (cookie keys, signing keys, session HMAC key).
  secret(name, make) {
    const row = this.one("SELECT value FROM secrets WHERE name = ?", name);
    if (row) return JSON.parse(row.value);
    const value = make();
    this.run("INSERT INTO secrets (name, value) VALUES (?, ?)", name, JSON.stringify(value));
    return value;
  }

  // ---- Allowlist and accounts ----
  allow(email) {
    this.run("INSERT OR IGNORE INTO allow (email, added_at) VALUES (?, ?)", email.toLowerCase(), now());
  }
  disallow(email) {
    this.run("DELETE FROM allow WHERE email = ?", email.toLowerCase());
  }
  allowed(email) {
    return Boolean(this.one("SELECT 1 FROM allow WHERE email = ?", email.toLowerCase()));
  }
  accountFor(email) {
    email = email.toLowerCase();
    let a = this.one("SELECT * FROM accounts WHERE email = ?", email);
    if (!a) {
      this.run("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)", `a_${crypto.randomBytes(9).toString("base64url")}`, email, now());
      a = this.one("SELECT * FROM accounts WHERE email = ?", email);
    }
    return a;
  }
  account(id) {
    return this.one("SELECT * FROM accounts WHERE id = ?", id);
  }

  // ---- Machines ----
  machine(id) {
    return this.one("SELECT * FROM machines WHERE id = ?", id);
  }
  machineOf(accountId) {
    return this.one("SELECT * FROM machines WHERE account_id = ?", accountId);
  }
  // One machine per account: a new one replaces the old.
  addMachine({ accountId, name, os, bridgeVersion, publicKey }) {
    const id = `m_${crypto.randomBytes(9).toString("base64url")}`;
    this.run("DELETE FROM machines WHERE account_id = ?", accountId);
    this.run("INSERT INTO machines (id, account_id, name, os, bridge_version, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, accountId, name, os, bridgeVersion, publicKey, now());
    return id;
  }
  removeMachine(id) {
    this.run("DELETE FROM machines WHERE id = ?", id);
  }

  // ---- Pairing codes ----
  addPairing(p) {
    this.run("DELETE FROM pairings WHERE expires_at < ?", now());
    this.run("INSERT INTO pairings (device_code, user_code, public_key, name, os, bridge_version, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
      p.deviceCode, p.userCode, p.publicKey, p.name, p.os, p.bridgeVersion, p.expiresAt);
  }
  pairingByCode(userCode) {
    return this.one("SELECT * FROM pairings WHERE user_code = ?", userCode);
  }
  pairingByDevice(deviceCode) {
    return this.one("SELECT * FROM pairings WHERE device_code = ?", deviceCode);
  }
  setPairing(deviceCode, fields) {
    const keys = Object.keys(fields);
    this.run(`UPDATE pairings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE device_code = ?`, ...keys.map((k) => fields[k]), deviceCode);
  }
  deletePairing(deviceCode) {
    this.run("DELETE FROM pairings WHERE device_code = ?", deviceCode);
  }

  // ---- ChatGPT grants (oidc-provider Grant records) ----
  grants(accountId) {
    return this.q("SELECT id, payload FROM oidc WHERE model = 'Grant' AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)", accountId, now())
      .map((r) => ({ id: r.id, ...JSON.parse(r.payload) }));
  }
  grantCount(accountId) {
    return this.one("SELECT count(*) AS n FROM oidc WHERE model = 'Grant' AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)", accountId, now()).n;
  }
  clientName(clientId) {
    const r = this.one("SELECT payload FROM oidc WHERE model = 'Client' AND id = ?", clientId);
    return r ? JSON.parse(r.payload).client_name || clientId : clientId;
  }

  sweep() {
    this.run("DELETE FROM oidc WHERE expires_at IS NOT NULL AND expires_at < ?", now());
    this.run("DELETE FROM pairings WHERE expires_at < ?", now());
  }

  // The oidc-provider adapter interface (upsert, find, findByUid, findByUserCode, consume,
  // destroy, revokeByGrantId), one instance per model, all in the oidc table.
  adapterClass() {
    const store = this;
    return class SqliteAdapter {
      constructor(model) {
        this.model = model;
      }
      async upsert(id, payload, expiresIn) {
        const expires = typeof expiresIn === "number" ? now() + expiresIn : null;
        store.run("INSERT OR REPLACE INTO oidc (model, id, payload, grant_id, user_code, uid, account_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          this.model, id, JSON.stringify(payload), payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, payload.accountId ?? null, expires);
        if (this.model === "Grant" && payload.accountId) store.onGrantChange(payload.accountId);
      }
      #get(where, value) {
        const r = store.one(`SELECT payload, expires_at FROM oidc WHERE model = ? AND ${where} = ?`, this.model, value);
        if (!r || (r.expires_at !== null && r.expires_at < now())) return undefined;
        return JSON.parse(r.payload);
      }
      async find(id) {
        return this.#get("id", id);
      }
      async findByUid(uid) {
        return this.#get("uid", uid);
      }
      async findByUserCode(userCode) {
        return this.#get("user_code", userCode);
      }
      async consume(id) {
        const r = store.one("SELECT payload FROM oidc WHERE model = ? AND id = ?", this.model, id);
        if (!r) return;
        const p = JSON.parse(r.payload);
        p.consumed = now();
        store.run("UPDATE oidc SET payload = ? WHERE model = ? AND id = ?", JSON.stringify(p), this.model, id);
      }
      async destroy(id) {
        const r = store.one("SELECT account_id FROM oidc WHERE model = ? AND id = ?", this.model, id);
        store.run("DELETE FROM oidc WHERE model = ? AND id = ?", this.model, id);
        if (this.model === "Grant" && r?.account_id) store.onGrantChange(r.account_id);
      }
      async revokeByGrantId(grantId) {
        store.run("DELETE FROM oidc WHERE grant_id = ? AND model != 'Grant'", grantId);
      }
    };
  }
}
