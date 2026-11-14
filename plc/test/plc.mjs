import { readFileSync } from "node:fs";
import { parse, Runtime } from "./st.mjs";
import { NEW_VARS, prog1Vars } from "./decls.mjs";

import { fileURLToPath } from "node:url";
const PLC = fileURLToPath(new URL("../", import.meta.url));
const prog1Raw = readFileSync(PLC + "Controller/Controller/Micro850/Micro850/PROG1.txt", "utf8");
const prog1Src = prog1Raw
  .replace(/__STEPPRAGMA[\s\S]*?__ENDSTEPPRAGMA/g, "")
  .replace(/^__GL [^\n]*$/gm, "");

export const ORDER = ["S00_Inputs", "Prog1", "S03_Admission", "S04_Supervisor", "S05_Stations", "S07_Publish"];

export function makePlc() {
  const seen = new Set();
  const decls = [];
  for (const d of [...prog1Vars(prog1Src.replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/T#\d+MS/gi, " ")), ...NEW_VARS]) {
    const N = d[0].toUpperCase();
    if (seen.has(N)) {
      const prev = decls.find((x) => x[0].toUpperCase() === N);
      if (prev[1] !== d[1]) throw new Error(`type clash for ${N}: ${prev[1]} vs ${d[1]}`);
      continue;
    }
    seen.add(N);
    decls.push(d);
  }
  const rt = new Runtime(decls.map(([n, t, i]) => [n, t, i]));
  const progs = ORDER.map((name) => [name, parse(name === "Prog1" ? prog1Src : readFileSync(PLC + name + ".st", "utf8"))]);
  let first = true;
  return {
    rt,
    decls,
    /** One controller scan at time `ms`. */
    scan(ms) {
      rt.now = ms;
      rt.set("__SYSVA_FIRST_SCAN", first);
      for (const [name, p] of progs) rt.run(p, name);
      first = false;
    },
    g: (n) => rt.get(n),
    s: (n, v) => rt.set(n, v),
  };
}
