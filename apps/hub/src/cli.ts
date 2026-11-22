// Hub operations CLI: `node src/cli.ts <command>`. Reads HUB_DB from the environment.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "@graphharness/db";
import { rebuildAllStates } from "./services/evidence.ts";
import { exportKnowledge } from "./services/knowledge-export.ts";

const USAGE = `Usage:
  cli.ts rebuild-states
  cli.ts rotate-mcp-token [--env-file /etc/graphharness/hub.env] [--token-file ~/.config/hub-mcp/token]
  cli.ts export-knowledge <dir>`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fail(`Missing value for ${name}`);
}

/** Replaces (or adds) the given variable (HUB_MCP_TOKEN) in an environment file. */
function setEnvVar(path: string, key: string, value: string): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function rotateMcpToken(args: string[]): void {
  const envFile = option(args, "--env-file", "/etc/graphharness/hub.env");
  const tokenFile = option(args, "--token-file", process.env.HUB_MCP_TOKEN_FILE ?? join(homedir(), ".config", "hub-mcp", "token"));
  const token = randomBytes(32).toString("hex");
  setEnvVar(envFile, "HUB_MCP_TOKEN", token);
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  console.log(`Token rotated: ${envFile} and ${tokenFile} updated (0600).`);
  console.log("Restart the Hub to pick it up: sudo systemctl restart hub.service");
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "rebuild-states": {
    const db = openDb();
    console.log(`States rebuilt: ${rebuildAllStates(db)} concepts`);
    db.close();
    break;
  }
  case "rotate-mcp-token":
    rotateMcpToken(args);
    break;
  case "export-knowledge": {
    const dir = args[0] ?? fail(USAGE);
    const db = openDb();
    console.log(`Exported ${exportKnowledge(db, dir)} Markdown files to ${dir}`);
    db.close();
    break;
  }
  default:
    fail(USAGE);
}
