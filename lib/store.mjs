// Small durable store: one JSON file per record, written atomically, so a crash
// mid-write never leaves a half-written file behind.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  #file(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`Bad record id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  save(id, value) {
    const file = this.#file(id);
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    // Windows refuses to replace a file another program (antivirus, a reader) has open
    // for a moment; retry briefly instead of failing the task.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), "utf8"));
    } catch {
      return null;
    }
  }

  remove(id) {
    fs.rmSync(this.#file(id), { force: true });
  }

  all() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")));
      } catch {
        // A corrupt file is skipped rather than taking the whole bridge down.
      }
    }
    return out;
  }
}
