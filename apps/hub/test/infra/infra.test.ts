// Infrastructure tests: credential-free backup, restore, export and token rotation.
// They require sqlite3 and rsync in the PATH: if missing it is an environment failure and the test fails with that error.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@graphharness/db";
import { createApp } from "../../src/app.ts";
import { makeTestContext, seedConcept, seedProposition, seedSubject } from "../../src/testing.ts";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(HUB, "..", "..");
const BACKUP = join(REPO, "infra", "scripts", "backup.sh");
const RESTORE = join(REPO, "infra", "scripts", "restore.sh");
const CLI = join(HUB, "src", "cli.ts");

let root: string;
let subjectId: string;
const t = (...p: string[]) => join(root, ...p);
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).sort();

/** If one is missing, execFileSync throws ENOENT: it is an environment failure and is not simulated. */
function needTools(): void {
  sh("sqlite3", ["--version"]);
  sh("rsync", ["--version"]);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "infra-test-"));
  // LH data with credentials mixed in.
  for (const f of ["auth.json", "settings.json", "chats/x.json", "chatgpt-credentials.json", "my-token.txt", "key.pem", "debug/provider-events/c.jsonl", "jobs/j1.json", "graph/nodes.jsonl"]) {
    mkdirSync(dirname(t("lh", f)), { recursive: true });
    writeFileSync(t("lh", f), "content");
  }
  // Reports: .tex yes, .pdf no.
  mkdirSync(t("reports"));
  writeFileSync(t("reports", "report.tex"), "\\documentclass{article}");
  writeFileSync(t("reports", "report.pdf"), "%PDF");
  // Real database with data.
  const db = openDb(t("hub.sqlite"));
  subjectId = seedSubject(db, { name: "Linear Algebra" });
  const c1 = seedConcept(db, { subjectId, name: "Eigenvalues", description: "Roots of the characteristic polynomial." });
  seedConcept(db, { subjectId, name: "Bases" });
  seedProposition(db, { conceptId: c1, name: "Cayley-Hamilton", statement: "Every matrix annihilates its characteristic polynomial." });
  db.close();
  execFileSync("git", ["init", "-q", t("backup")]);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("backup.sh", () => {
  it("does not upload credentials, dumps the database in order, exports knowledge/ and commits without push", () => {
    needTools();
    sh(BACKUP, ["test-reason"], {
      BACKUP_DIR: t("backup"), HUB_DB: t("hub.sqlite"), LH_DATA_DIR: t("lh"), HUB_REPORTS_DIR: t("reports"), BACKUP_PUSH: "0",
    });
    expect(files(t("backup", "lh-data"))).toEqual(["chats/x.json", "graph/nodes.jsonl", "settings.json"]);
    expect(files(t("backup", "reports"))).toEqual(["report.tex"]);

    const sql = readFileSync(t("backup", "hub", "hub.sql"), "utf8");
    // After 005 (rebuild of subjects/cards) SQLite's .dump emits IF NOT EXISTS + quotes.
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?subjects"?/);
    expect(sql.indexOf("'Eigenvalues'")).toBeGreaterThan(-1);
    expect(sql.indexOf("'Eigenvalues'")).toBeLessThan(sql.indexOf("'Bases'")); // deterministic order by rowid

    const md = files(t("backup", "knowledge"));
    expect(md.filter((f) => f.startsWith("concepts/"))).toHaveLength(2);
    expect(md.filter((f) => f.startsWith("subjects/"))).toHaveLength(1);

    const log = sh("git", ["-C", t("backup"), "log", "-1", "--format=%s"]).trim();
    expect(log).toMatch(/^backup: \d{4}-\d{2}-\d{2}T.* test-reason$/);
    const tracked = sh("git", ["-C", t("backup"), "ls-files"]);
    expect(tracked).not.toMatch(/auth|token|credential|\.pem|jobs\/|debug\//);

    const db = openDb(t("hub.sqlite"));
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    db.close();
    expect(meta.last_backup_at).toBeTruthy();
    expect(Number(meta.backup_repo_bytes)).toBeGreaterThan(0);
  });
});

describe("restore.sh (F1 restore test)", () => {
  it("reproduces the database: same GET /subjects/:id/map and same tables", async () => {
    needTools();
    sh(RESTORE, [t("backup"), t("restored", "hub.sqlite"), t("restored", "lh")]);
    expect(files(t("restored", "lh"))).toEqual(["chats/x.json", "graph/nodes.jsonl", "settings.json"]);

    const original = openDb(t("hub.sqlite"));
    const restored = openDb(t("restored", "hub.sqlite"));
    const get = async (db: typeof original) =>
      createApp(makeTestContext({ db }), { pwaDist: "/nonexistent" }).request(`/api/v1/subjects/${subjectId}/map`);
    const [a, b] = [await get(original), await get(restored)];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    for (const table of ["subjects", "concepts", "lh_propositions", "concept_propositions", "schema_migrations"]) {
      expect(restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(original.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    }
    original.close();
    restored.close();
  });
});

describe("cli", () => {
  it("export-knowledge: one .md per subject and concept, with method sheet/limits/errors, and deletes the obsolete ones", () => {
    const db = openDb(t("hub.sqlite"));
    const cid = db.prepare("SELECT id FROM concepts WHERE name = 'Eigenvalues'").pluck().get() as string;
    db.prepare("INSERT INTO templates (id, concept_id, slug, name, method_summary, method_limits, recipe_json, status, created_at) VALUES ('t1', ?, 'tpl', 'Diagonalize', 'Sheet X', 'Limit Y', '{}', 'active', 'x')").run(cid);
    db.prepare("INSERT INTO template_errors (id, template_id, key, description, expr, origin) VALUES ('e1', 't1', 'wrong_sign', 'Flips the sign', '0', 'recipe')").run();
    db.close();
    const out = t("kn");
    mkdirSync(join(out, "concepts"), { recursive: true });
    writeFileSync(join(out, "concepts", "old.md"), "obsolete");
    sh("node", [CLI, "export-knowledge", out], { HUB_DB: t("hub.sqlite") });
    const names = files(out);
    expect(names).not.toContain("concepts/old.md");
    expect(names).toHaveLength(3);
    const concept = readFileSync(join(out, names.find((n) => n.startsWith("concepts/") && readFileSync(join(out, n), "utf8").startsWith("# Eigenvalues"))!), "utf8");
    for (const s of ["Effective state: **unknown**", "Cayley-Hamilton", "Method sheet", "Sheet X", "Limit Y", "`wrong_sign`"]) expect(concept).toContain(s);
    // Stable: re-exporting does not change the names.
    sh("node", [CLI, "export-knowledge", out], { HUB_DB: t("hub.sqlite") });
    expect(files(out)).toEqual(names);
  });

  it("rotate-mcp-token rewrites the env and the agent's file with 0600", () => {
    writeFileSync(t("hub.env"), "HUB_PORT=4100\nHUB_MCP_TOKEN=old\nOTHER=1\n", { mode: 0o644 });
    sh("node", [CLI, "rotate-mcp-token", "--env-file", t("hub.env"), "--token-file", t("agent", "token")]);
    const env = readFileSync(t("hub.env"), "utf8");
    const token = readFileSync(t("agent", "token"), "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(env).toBe(`HUB_PORT=4100\nHUB_MCP_TOKEN=${token}\nOTHER=1\n`);
    expect(statSync(t("hub.env")).mode & 0o777).toBe(0o600);
    expect(statSync(t("agent", "token")).mode & 0o777).toBe(0o600);
    expect(existsSync(t("agent", "token"))).toBe(true);
  });
});
