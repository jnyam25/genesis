/**
 * Load the repo-root `.env` and then `.env.local` before a CLI reads process.env.
 * A value already set in the shell is left alone. `.env.local` wins over `.env`.
 * An empty value is ignored.
 */
import * as fs from "fs";
import * as path from "path";

function repoRoot(): string | null {
  const starts = [process.cwd(), __dirname];
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      if (fs.existsSync(path.join(dir, ".env.example")) && fs.existsSync(path.join(dir, "twin")) && fs.existsSync(path.join(dir, "hmi"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function loadLocalEnv(): void {
  const root = repoRoot();
  if (!root) return;
  const merged = new Map<string, string>();
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const body = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = body.indexOf("=");
      if (eq < 1) continue;
      const key = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = body.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (value !== "") merged.set(key, value);
    }
  }
  for (const [key, value] of merged) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
