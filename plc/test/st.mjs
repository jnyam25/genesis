// Minimal IEC 61131-3 structured-text interpreter for the Genesis programs.
// Case-insensitive identifiers, typed globals with range checks on assignment,
// CCW semantics: both sides of AND/OR are evaluated (so out-of-range indexes throw).

const KW = new Set(["IF", "THEN", "ELSIF", "ELSE", "END_IF", "FOR", "TO", "BY", "DO", "END_FOR", "WHILE", "END_WHILE",
  "CASE", "OF", "END_CASE", "EXIT", "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE", "RETURN"]);

export function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("(*", i)) { const e = src.indexOf("*)", i + 2); if (e < 0) throw new Error("unterminated comment"); i = e + 2; continue; }
    if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
    let m;
    const rest = src.slice(i, i + 40);
    if ((m = /^T#(\d+)(MS|S|H)\b/i.exec(rest))) { t.push({ k: "num", v: ({ S: 1000, H: 3600000, MS: 1 })[m[2].toUpperCase()] * Number(m[1]), time: true }); i += m[0].length; continue; }
    if ((m = /^\d+\.\d+/.exec(rest))) { t.push({ k: "num", v: Number(m[0]), real: true }); i += m[0].length; continue; }
    if ((m = /^\d+/.exec(rest))) { t.push({ k: "num", v: Number(m[0]) }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const u = m[0].toUpperCase();
      t.push(KW.has(u) ? { k: u } : { k: "id", v: u });
      i += m[0].length; continue;
    }
    if ((m = /^(:=|<>|<=|>=|\.\.)/.exec(rest))) { t.push({ k: m[0] }); i += m[0].length; continue; }
    if ("+-*/=<>()[],;:.".includes(c)) { t.push({ k: c }); i++; continue; }
    throw new Error(`bad char ${JSON.stringify(c)} near ${JSON.stringify(src.slice(i, i + 30))}`);
  }
  t.push({ k: "eof" });
  return t;
}

export function parse(src) {
  const t = tokenize(src);
  let p = 0;
  const peek = (o = 0) => t[p + o];
  const eat = (k) => { if (t[p].k !== k) throw new Error(`expected ${k} got ${t[p].k} ${t[p].v ?? ""} at token ${p}`); return t[p++]; };
  const isCaseLabel = () => {
    let q = p;
    if (t[q].k === "-") q++;
    if (t[q].k !== "num") return false;
    q++;
    while (t[q].k === ",") { q++; if (t[q].k === "-") q++; if (t[q].k !== "num") return false; q++; }
    return t[q].k === ":";
  };
  function stmts(stop) {
    const out = [];
    while (!stop.includes(peek().k) && !(stop.includes("label") && isCaseLabel())) out.push(stmt());
    return out;
  }
  function stmt() {
    const k = peek().k;
    if (k === ";") { p++; return { s: "nop" }; }
    if (k === "IF") {
      p++;
      const arms = [];
      let c = expr(); eat("THEN");
      arms.push([c, stmts(["ELSIF", "ELSE", "END_IF"])]);
      let els = [];
      while (peek().k === "ELSIF") { p++; c = expr(); eat("THEN"); arms.push([c, stmts(["ELSIF", "ELSE", "END_IF"])]); }
      if (peek().k === "ELSE") { p++; els = stmts(["END_IF"]); }
      eat("END_IF"); if (peek().k === ";") p++;
      return { s: "if", arms, els };
    }
    if (k === "FOR") {
      p++; const v = eat("id").v; eat(":="); const a = expr(); eat("TO"); const b = expr();
      let by = { e: "num", v: 1 }; if (peek().k === "BY") { p++; by = expr(); }
      eat("DO"); const body = stmts(["END_FOR"]); eat("END_FOR"); if (peek().k === ";") p++;
      return { s: "for", v, a, b, by, body };
    }
    if (k === "WHILE") {
      p++; const c = expr(); eat("DO"); const body = stmts(["END_WHILE"]); eat("END_WHILE"); if (peek().k === ";") p++;
      return { s: "while", c, body };
    }
    if (k === "CASE") {
      p++; const x = expr(); eat("OF");
      const arms = []; let els = [];
      while (isCaseLabel()) {
        const labels = [];
        do { if (peek().k === ",") p++; let neg = 1; if (peek().k === "-") { p++; neg = -1; } labels.push(neg * eat("num").v); } while (peek().k === ",");
        eat(":");
        arms.push([labels, stmts(["label", "ELSE", "END_CASE"])]);
      }
      if (peek().k === "ELSE") { p++; els = stmts(["END_CASE"]); }
      eat("END_CASE"); if (peek().k === ";") p++;
      return { s: "case", x, arms, els };
    }
    if (k === "EXIT") { p++; eat(";"); return { s: "exit" }; }
    // assignment or FB call
    const ref = lvalue();
    if (peek().k === "(") {
      p++; const args = [];
      while (peek().k !== ")") {
        if (peek().k === "id" && peek(1).k === ":=") { const n = eat("id").v; p++; args.push([n, expr()]); }
        else args.push([null, expr()]);
        if (peek().k === ",") p++;
      }
      eat(")"); eat(";");
      return { s: "call", fb: ref, args };
    }
    eat(":="); const e = expr(); eat(";");
    return { s: "set", ref, e };
  }
  function lvalue() {
    let r = { e: "var", n: eat("id").v };
    for (;;) {
      if (peek().k === "[") { p++; const i = expr(); eat("]"); r = { e: "idx", of: r, i }; continue; }
      if (peek().k === "." && peek(1).k === "id") { p++; r = { e: "fld", of: r, f: eat("id").v }; continue; }
      return r;
    }
  }
  const bin = (next, ops) => () => {
    let l = next();
    while (ops.includes(peek().k)) { const op = t[p++].k; l = { e: "bin", op, l, r: next() }; }
    return l;
  };
  function unary() {
    if (peek().k === "NOT") { p++; return { e: "not", x: unary() }; }
    if (peek().k === "-") { p++; return { e: "neg", x: unary() }; }
    return primary();
  }
  function primary() {
    const k = peek().k;
    if (k === "num") { const tk = t[p++]; return { e: "num", v: tk.v, real: !!tk.real }; }
    if (k === "TRUE") { p++; return { e: "num", v: true }; }
    if (k === "FALSE") { p++; return { e: "num", v: false }; }
    if (k === "(") { p++; const x = expr(); eat(")"); return x; }
    if (k === "id" && peek(1).k === "(") {
      const n = eat("id").v; p++; const args = [];
      while (peek().k !== ")") { args.push(expr()); if (peek().k === ",") p++; }
      eat(")"); return { e: "fn", n, args };
    }
    return lvalue();
  }
  const mul = bin(unary, ["*", "/", "MOD"]);
  const add = bin(mul, ["+", "-"]);
  const cmp = bin(add, ["<", ">", "<=", ">="]);
  const eq = bin(cmp, ["=", "<>"]);
  const and = bin(eq, ["AND"]);
  const xor = bin(and, ["XOR"]);
  const expr = bin(xor, ["OR"]);
  const prog = stmts(["eof"]);
  return prog;
}

// ---------------- runtime ----------------
const RANGE = { BOOL: null, USINT: [0, 255], UINT: [0, 65535], INT: [-32768, 32767], UDINT: [0, 4294967295], DINT: [-2147483648, 2147483647], REAL: null };

export class Runtime {
  constructor(decls) {
    this.types = new Map(); // NAME -> {type, lo?, hi?, fb?}
    this.v = new Map();
    this.now = 0; // ms
    this.used = new Set();
    for (const [name, type, init] of decls) this.declare(name, type, init);
  }
  declare(name, type, init) {
    const N = name.toUpperCase();
    const m = /^ARRAY\[(-?\d+)\.\.(\d+)\] OF (\w+)$/.exec(type);
    if (m) {
      const lo = +m[1], hi = +m[2], el = m[3];
      this.types.set(N, { type: el, lo, hi, arr: true });
      const a = {}; for (let i = lo; i <= hi; i++) a[i] = el === "TON" ? newTon() : (init ?? (el === "BOOL" ? false : 0));
      this.v.set(N, a);
    } else {
      this.types.set(N, { type });
      this.v.set(N, type === "TON" ? newTon() : (init ?? (type === "BOOL" ? false : 0)));
    }
  }
  get(n) { const N = n.toUpperCase(); if (!this.v.has(N)) throw new Error(`undeclared ${N}`); return this.v.get(N); }
  set(n, val) { const N = n.toUpperCase(); if (!this.v.has(N)) throw new Error(`undeclared ${N}`); this.v.set(N, val); }
  run(prog, ctx = "") { this.ctx = ctx; this.block(prog); }
  block(list) { for (const s of list) { const r = this.stmt(s); if (r === "exit") return "exit"; } }
  stmt(s) {
    switch (s.s) {
      case "nop": return;
      case "set": return this.assign(s.ref, this.ev(s.e));
      case "if": {
        for (const [c, b] of s.arms) if (this.truth(this.ev(c))) return this.block(b);
        return this.block(s.els);
      }
      case "for": {
        const a = this.ev(s.a), b = this.ev(s.b), by = this.ev(s.by);
        let guard = 0;
        for (let i = a; by > 0 ? i <= b : i >= b; i += by) {
          this.assign({ e: "var", n: s.v }, i);
          if (this.block(s.body) === "exit") break;
          if (++guard > 100000) throw new Error("runaway FOR");
        }
        return;
      }
      case "while": {
        let guard = 0;
        while (this.truth(this.ev(s.c))) { if (this.block(s.body) === "exit") break; if (++guard > 100000) throw new Error("runaway WHILE"); }
        return;
      }
      case "case": {
        const x = this.ev(s.x);
        for (const [labels, b] of s.arms) if (labels.includes(Number(x))) return this.block(b);
        return this.block(s.els);
      }
      case "exit": return "exit";
      case "call": {
        const fb = this.lget(s.fb);
        if (!fb || fb.kind !== "TON") throw new Error(`call of non-FB ${JSON.stringify(s.fb)}`);
        let IN, PT;
        s.args.forEach(([n, e], i) => { const v = this.ev(e); if (n === "IN" || (n === null && i === 0)) IN = v; else PT = v; });
        stepTon(fb, !!IN, PT, this.now);
        return;
      }
    }
    throw new Error("bad stmt " + s.s);
  }
  truth(v) { if (typeof v !== "boolean") throw new Error(`non-BOOL condition (${v}) in ${this.ctx}`); return v; }
  typeOf(ref) {
    if (ref.e === "var") return this.types.get(ref.n);
    if (ref.e === "idx") return this.typeOf(ref.of);
    return null;
  }
  lget(ref) {
    if (ref.e === "var") { this.used.add(ref.n); return this.get(ref.n); }
    if (ref.e === "idx") {
      const base = this.lget(ref.of), ty = this.typeOf(ref.of), i = this.ev(ref.i);
      if (!ty?.arr) throw new Error(`index into non-array ${ref.of.n}`);
      if (!Number.isInteger(i) || i < ty.lo || i > ty.hi) throw new Error(`index ${i} out of range ${ty.lo}..${ty.hi} for ${ref.of.n} in ${this.ctx}`);
      return base[i];
    }
    if (ref.e === "fld") { const fb = this.lget(ref.of); return fb[ref.f]; }
    throw new Error("bad ref");
  }
  assign(ref, val) {
    const ty = this.typeOf(ref);
    if (!ty) throw new Error("assign to " + JSON.stringify(ref));
    const T = ty.type;
    if (T === "BOOL") { if (typeof val !== "boolean") throw new Error(`BOOL := ${val} (${refName(ref)}) in ${this.ctx}`); }
    else {
      if (typeof val !== "number") throw new Error(`${T} := ${val} (${refName(ref)}) in ${this.ctx}`);
      const r = RANGE[T];
      if (r && (!Number.isInteger(val) || val < r[0] || val > r[1])) throw new Error(`${T} out of range: ${refName(ref)} := ${val} in ${this.ctx}`);
    }
    if (ref.e === "var") { this.used.add(ref.n); this.set(ref.n, val); return; }
    const base = this.lget(ref.of), i = this.ev(ref.i);
    if (!Number.isInteger(i) || i < ty.lo || i > ty.hi) throw new Error(`index ${i} out of range for ${refName(ref)} in ${this.ctx}`);
    base[i] = val;
  }
  isReal(e) {
    if (e.e === "num") return e.real;
    if (e.e === "var" || e.e === "idx") return this.typeOf(e)?.type === "REAL";
    if (e.e === "fn") return e.n === "ANY_TO_REAL";
    if (e.e === "bin") return this.isReal(e.l) || this.isReal(e.r);
    if (e.e === "neg") return this.isReal(e.x);
    return false;
  }
  ev(e) {
    switch (e.e) {
      case "num": return e.v;
      case "var": case "idx": case "fld": return this.lget(e);
      case "not": { const x = this.ev(e.x); if (typeof x !== "boolean") throw new Error(`NOT on number in ${this.ctx}`); return !x; }
      case "neg": return -this.ev(e.x);
      case "fn": {
        const a = e.args.map((x) => this.ev(x));
        const num = (x) => (typeof x === "boolean" ? (x ? 1 : 0) : x);
        switch (e.n) {
          case "ANY_TO_REAL": return num(a[0]);
          case "ANY_TO_UINT": case "ANY_TO_USINT": case "ANY_TO_INT": case "ANY_TO_UDINT": case "ANY_TO_DINT": {
            const v = Math.trunc(num(a[0]));
            const r = RANGE[e.n.slice(7)];
            if (v < r[0] || v > r[1]) throw new Error(`${e.n}(${v}) out of range in ${this.ctx}`);
            return v;
          }
          case "MIN": return Math.min(...a);
          case "MAX": return Math.max(...a);
          case "ABS": return Math.abs(a[0]);
        }
        throw new Error("unknown function " + e.n);
      }
      case "bin": {
        const l = this.ev(e.l), r = this.ev(e.r); // both sides, like CCW
        switch (e.op) {
          case "AND": case "OR": case "XOR":
            if (typeof l !== "boolean" || typeof r !== "boolean") throw new Error(`${e.op} on numbers in ${this.ctx}`);
            return e.op === "AND" ? l && r : e.op === "OR" ? l || r : l !== r;
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": if (r === 0) throw new Error(`divide by zero in ${this.ctx}`); return this.isReal(e) ? l / r : Math.trunc(l / r);
          case "MOD": return l % r;
          case "=": return l === r;
          case "<>": return l !== r;
          case "<": return l < r;
          case ">": return l > r;
          case "<=": return l <= r;
          case ">=": return l >= r;
        }
      }
    }
    throw new Error("bad expr " + e.e);
  }
}
const refName = (r) => (r.e === "var" ? r.n : r.e === "idx" ? refName(r.of) + "[]" : "?");
function newTon() { return { kind: "TON", Q: false, ET: 0, start: null, IN: false }; }
function stepTon(fb, IN, PT, now) {
  if (!IN) { fb.Q = false; fb.ET = 0; fb.start = null; }
  else {
    if (fb.start === null) fb.start = now;
    fb.ET = Math.min(PT, now - fb.start);
    fb.Q = now - fb.start >= PT;
  }
  fb.IN = IN;
}
