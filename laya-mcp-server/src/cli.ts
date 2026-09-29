import { bootstrap, decideChoice, isReady, CACHE_DIR } from "./engine.ts";
import { homedir } from "os";
import { join } from "path";
const MODEL_FILE = join(process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya"), "receptron--laya-onnx", "main", "laya.onnx.data");

const args = process.argv.slice(2);
const useDoctor = args.includes("--doctor") || args.includes("--test");
const usePlayground = args.includes("--playground");

function bar(p: number, w = 20): string {
  const f = Math.round(p * w);
  return "█".repeat(f) + "░".repeat(w - f) + ` ${(p * 100).toFixed(1)}%`;
}

async function doctor() {
  const wantFetch = args.includes("--fetch");
  console.log("=== Laya Doctor ===");
  console.log(`bun ${Bun.version} | ${process.platform}`);
  for (const f of [MODEL_FILE]) console.log(`${f}: ${(await Bun.file(f).exists()) ? "cached" : "missing (degraded ok)"}`);
  console.log(`cache: ${CACHE_DIR}`);
  if (!wantFetch) console.log("tip: add --fetch to download 1.6GB weights (else check-only, fast)");
  let ok = false;
  const t0 = performance.now();
  await bootstrap((m) => console.log(`... ${m}`), { fetch: wantFetch });
  ok = isReady();
  const ms = Math.round(performance.now() - t0);
  console.log(ok ? "✔ ONNX engine ready" : "⚠ degraded heuristic mode (no weights — still usable)");
  const r = await decideChoice("Redis connection refused on 127.0.0.1:6379", "root cause?", ["database_down", "network_firewall", "auth_failure"]);
  console.log("\n-- distribution --");
  for (const [k, v] of Object.entries(r.distribution)) console.log(`${String(k).padEnd(18)} ${bar(v as number)}`);
  console.log(`top: ${r.selected} conf=${r.confidence} degraded=${r.degraded_mode}`);
  console.log(`done in ${ms}ms — ready for MCP`);
}

async function playground() {
  await bootstrap((m) => console.error(`[laya] ${m}`));
  console.log("laya playground — type: question | opt1 | opt2 | opt3 (empty to quit)");
  for await (const line of console) {
    const parts = line.split("|").map((s: string) => s.trim()).filter(Boolean);
    if (!parts.length) break;
    if (parts.length < 3) { console.log("need: question | optA | optB [...]"); continue; }
    const [q, ...opts] = parts;
    const r = await decideChoice("", q, opts);
    for (const [k, v] of Object.entries(r.distribution)) console.log(`${String(k).padEnd(16)} ${bar(v as number)}`);
    console.log(`→ ${r.selected} (${r.confidence}) degraded=${r.degraded_mode}\n`);
  }
}

if (useDoctor) await doctor();
else if (usePlayground) await playground();
else {
  console.log("use: bun src/cli.ts --doctor | --playground | bun src/server.ts (stdio)");
  await doctor();
}
