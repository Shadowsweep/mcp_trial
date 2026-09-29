import { homedir } from "os";
import { join } from "path";

export const REPO_ID = "receptron/laya-onnx";
export const CACHE_DIR =
  process.env.LAYA_CACHE_DIR || join(homedir(), ".cache", "laya-mcp");
export const MAX_BYTES = 8192;
export const MAX_OPTIONS = 20;

type LayaInst = {
  systemOne: (state: unknown, q: any) => Promise<any>;
  close?: () => Promise<void>;
};
let laya: LayaInst | null = null;
let attempted = false;
let chain: Promise<any> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(() => {}, () => {});
  return run;
}

// ponytail: whitespace approx tokens for truncated flag; real tok lives inside @receptron/laya
export function sanitize(raw: unknown): string {
  let s = typeof raw === "string" ? raw : String(raw ?? "");
  s = s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  try { s = Buffer.from(s, "utf8").toString("utf8"); } catch { /* keep */ }
  s = s.normalize("NFKC").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u202E\u200B-\u200F]/g, "");
  s = s.replace(/[ \t]+/g, " ").trim();
  return Buffer.from(s, "utf8").slice(0, MAX_BYTES).toString("utf8");
}

export function approxTokens(text: string): number[] {
  return text.split(/\s+/).filter(Boolean).map((w) => {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    return h % 30000;
  });
}

export function sandwich(ids: number[], head = 192, tail = 320): { ids: number[]; truncated: boolean } {
  if (ids.length <= 512) return { ids, truncated: false };
  return { ids: [...ids.slice(0, head), ...ids.slice(ids.length - tail)], truncated: true };
}

export function softmax(l: number[]): number[] {
  const m = Math.max(...l);
  const e = l.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / s);
}
export function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

export function isReady(): boolean { return laya !== null; }

// ponytail: tiny LRU, stdlib Map only. Never caches degraded/low-confidence answers.
const CACHE_MAX = Number(process.env.LAYA_CACHE_MAX || 1000);
const cache = new Map<string, any>();
async function shaKey(s: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}
function cacheGet<T>(k: string): (T & { cached: true; infer_ms: 0 }) | null {
  const v = cache.get(k);
  if (!v) return null;
  cache.delete(k); cache.set(k, v); // refresh recency
  return { ...v, cached: true, infer_ms: 0 };
}
function cacheSet(k: string, v: any) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}
export function cacheStats() { return { size: cache.size, max: CACHE_MAX }; }

export async function tryLoadModel(): Promise<{ ok: boolean; reason: string }> {
  if (laya) return { ok: true, reason: "warm" };
  if (attempted) return { ok: false, reason: "cached-miss" };
  attempted = true;
  try {
    const { Laya } = await import("@receptron/laya");
    let lastLog = 0;
    // ponytail: thread count from env, measure infer_ms before changing it
    const threads = Number(process.env.LAYA_THREADS || 0);
    laya = await (Laya as any).load({
      cacheDir: process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya"),
      ...(threads > 0 ? { sessionOptions: { intraOpNumThreads: threads } } : {}),
      onProgress: ({ file, received, total }: any) => {
        const now = Date.now();
        // ponytail: throttle chunk spam, log every ~5s
        if (now - lastLog > 5000) {
          lastLog = now;
          console.error(`[laya] dl ${file} ${(received / 1048576).toFixed(0)}/${((total || 1685258240) / 1048576).toFixed(0)}MB`);
        }
      },
    });
    return { ok: true, reason: "loaded" };
  } catch (e: any) {
    laya = null;
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

export async function bootstrap(statusCb?: (m: string) => void, opts: { fetch?: boolean } = {}): Promise<boolean> {
  const cb = statusCb ?? (() => {});
  const wantFetch = opts.fetch ?? process.env.LAYA_AUTO_FETCH !== "0";
  if (!wantFetch) { cb("auto-fetch off, degraded mode (add --fetch for real weights)"); return false; }
  cb("loading Laya (downloads ~1.7GB on first use)...");
  const r = await tryLoadModel();
  cb(r.ok ? "ONNX ready" : `degraded: ${r.reason}`);
  return r.ok;
}

function heuristicScores(state: string, options: string[]): number[] {
  const pw = new Set(state.toLowerCase().split(/\W+/).filter(Boolean));
  // ponytail: infra boost fixes Redis-refused tie, embedding rerank only if this misfires
  const boost = (o: string) =>
    /refused|timeout|timed\s?out|econnrefused|connection/i.test(state) &&
    /database|db_|sql|redis|postgres|infra|network|connection|down/i.test(o) ? 1 : 0;
  const raw = options.map((o) => {
    const hit = o.toLowerCase().split(/\W+/).filter(Boolean).filter((w) => pw.has(w)).length;
    return hit + boost(o) + 0.1 / (1 + o.length / 50);
  });
  const s = raw.reduce((a, b) => a + b, 0);
  if (s === 0) return options.map(() => 1 / options.length);
  return raw.map((x) => x / s);
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export async function decideChoice(state: string, question: string, options: string[]) {
  const clean = sanitize(state);
  const q = sanitize(question);
  const opts = options.map(sanitize);
  const { truncated } = sandwich(approxTokens(`Q:${q} S:${clean}`));
  const key = await shaKey(`c|${clean}|${q}|${opts.join(",")}`);
  const hit = cacheGet<ReturnType<typeof heuristicScores> extends never ? never : any>(key);
  if (hit) return hit;
  const t0 = performance.now();
  if (laya) {
    try {
      const res = await withLock(() => laya!.systemOne(clean, {
        q: { type: "choice", instructions: q, criteria: opts },
      }));
      const a = res.answers.q;
      const out = { selected: a.choice, confidence: r4(a.confidence), distribution: a.probabilities, degraded_mode: false, truncated, input_tokens: res.usage?.input_tokens, infer_ms: Math.round(performance.now() - t0) };
      // ponytail: cache on strong distribution (max prob), not entropy-confidence (reads low ~0.4)
      const maxP = Math.max(...Object.values(a.probabilities) as number[]);
      if (maxP >= 0.6) cacheSet(key, out);
      return out;
    } catch (e: any) { console.error(`[laya] onnx fail, heuristic: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const probs = heuristicScores(clean + " " + q, opts);
  const ranked = opts.map((opt, i) => ({ opt, p: probs[i] })).sort((a, b) => b.p - a.p);
  return {
    selected: ranked[0].opt, confidence: r4(ranked[0].p),
    distribution: Object.fromEntries(ranked.map((r) => [r.opt, r4(r.p)])),
    degraded_mode: true, truncated, infer_ms: Math.round(performance.now() - t0),
  };
}

export async function scoreSeverity(state: string, scaleMax = 3, rubric?: string[]) {
  const clean = sanitize(state);
  const { truncated } = sandwich(approxTokens(clean));
  // ponytail: generic "level N" labels collapse to 0; use meaningful ordered rubric
  const levels = rubric && rubric.length === scaleMax + 1 ? rubric
    : scaleMax === 3 ? ["not urgent", "somewhat urgent", "urgent", "critical"]
    : Array.from({ length: scaleMax + 1 }, (_, i) => `severity ${i} of ${scaleMax}`);
  const t0 = performance.now();
  if (laya) {
    try {
      const res = await withLock(() => laya!.systemOne(clean, {
        q: { type: "score", instructions: "How severe/urgent is this?", criteria: levels },
      }));
      const a = res.answers.q;
      return { score: r4(a.score), confidence: r4(a.confidence), scale: `0-${scaleMax}`, distribution: a.probabilities, degraded_mode: false, truncated, infer_ms: Math.round(performance.now() - t0) };
    } catch (e: any) { console.error(`[laya] score fail: ${String(e?.message || e).slice(0, 80)}`); }
  }
  const hi = /critical|outage|breach|p0|segfault|refused|timeout/i.test(clean);
  return { score: hi ? scaleMax : Math.round(scaleMax / 2), confidence: hi ? 0.7 : 0.5, scale: `0-${scaleMax}`, degraded_mode: true, truncated, infer_ms: Math.round(performance.now() - t0) };
}

export async function gateBoolean(state: string, assertion: string) {
  const clean = sanitize(state);
  const a = sanitize(assertion);
  const t0 = performance.now();
  if (laya) {
    try {
      const res = await withLock(() => laya!.systemOne(clean, { q: { type: "noul", instructions: a } }));
      const p = res.answers.q.noul;
      return { assertion: a, is_true: p >= 0.5, probability_true: r4(p), degraded_mode: false, infer_ms: Math.round(performance.now() - t0) };
    } catch (e: any) { console.error(`[laya] gate fail: ${String(e?.message || e).slice(0, 80)}`); }
  }
  const danger = /ignore.*previous|dump.*env|jailbreak|system.*override|prompt injection/i.test(clean);
  const prob = danger ? 0.85 : 0.15;
  return { assertion: a, is_true: prob >= 0.5, probability_true: prob, degraded_mode: true, infer_ms: Math.round(performance.now() - t0) };
}

// ponytail: one forward pass for all three — ~3x fewer passes for agent loops that ask everything
export async function decideAll(state: string, question: string, options: string[], assertion: string, scaleMax = 3) {
  const clean = sanitize(state);
  const t0 = performance.now();
  if (laya) {
    try {
      const levels = ["not urgent", "somewhat urgent", "urgent", "critical"].slice(0, scaleMax + 1);
      const res = await withLock(() => laya!.systemOne(clean, {
        choice: { type: "choice", instructions: sanitize(question), criteria: options.map(sanitize) },
        severity: { type: "score", instructions: "How severe/urgent is this?", criteria: levels },
        guard: { type: "noul", instructions: sanitize(assertion) },
      }));
      return {
        degraded_mode: false,
        infer_ms: Math.round(performance.now() - t0),
        choice: { selected: res.answers.choice.choice, confidence: r4(res.answers.choice.confidence), distribution: res.answers.choice.probabilities },
        severity: { score: r4(res.answers.severity.score), distribution: res.answers.severity.probabilities },
        guard: { is_true: res.answers.guard.noul >= 0.5, probability_true: r4(res.answers.guard.noul) },
      };
    } catch (e: any) { console.error(`[laya] decideAll fail: ${String(e?.message || e).slice(0, 80)}`); }
  }
  const c = await decideChoice(clean, question, options);
  const s = await scoreSeverity(clean, scaleMax);
  const g = await gateBoolean(clean, assertion);
  return { degraded_mode: true, infer_ms: Math.round(performance.now() - t0), choice: c, severity: s, guard: g };
}
