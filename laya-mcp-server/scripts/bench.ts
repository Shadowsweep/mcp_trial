import { bootstrap, decideChoice, decideAll, cacheStats } from "../src/engine.ts";

// One warm process, N calls down the same session — measures load + per-call ms.
// Usage: LAYA_AUTO_FETCH=1 bun scripts/bench.ts
const t0 = performance.now();
await bootstrap((m) => console.error(`[bench] ${m}`), { fetch: true });
console.log(`load_ms=${Math.round(performance.now() - t0)}`);

const state = "Redis connection refused on 127.0.0.1:6379 after 30s timeout";
const times: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  const r = await decideChoice(state, "root cause?", ["database_down", "auth_failure", "network_firewall"]);
  times.push(Math.round(performance.now() - t));
  console.log(`call${i} infer_ms=${(r as any).infer_ms} selected=${r.selected} degraded=${r.degraded_mode}`);
}
// cache hit: same call again
const tc = performance.now();
await decideChoice(state, "root cause?", ["database_down", "auth_failure", "network_firewall"]);
console.log(`cache_hit_ms=${Math.round(performance.now() - tc)} cache=${JSON.stringify(cacheStats())}`);
// combined: 3 questions, 1 pass
const ta = performance.now();
const all = await decideAll(state, "root cause?", ["database_down", "auth_failure"], "contains outage");
console.log(`decide_all_ms=${Math.round(performance.now() - ta)} infer_ms=${(all as any).infer_ms} degraded=${all.degraded_mode}`);
console.log(`per_call_ms=[${times.join(",")}] threads=${process.env.LAYA_THREADS || "default"}`);
process.exit(0);
