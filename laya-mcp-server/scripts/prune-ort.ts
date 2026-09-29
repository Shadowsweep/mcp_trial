// Prune onnxruntime-node binaries for platforms we don't run on.
// onnxruntime-node ships linux+darwin+win/arm64 (~250MB dead weight on win32/x64).
// Usage: bun scripts/prune-ort.ts  (re-run after every bun install)
import { join } from "path";

const root = join(import.meta.dir, "..", "node_modules", "onnxruntime-node", "bin");
const keep = process.platform === "win32" ? ["win32"] : process.platform === "darwin" ? ["darwin"] : ["linux"];
// ponytail: keep only current OS; arch subfolders inside are tiny vs the OS folders
const { readdir, rm, stat } = await import("fs/promises");
async function size(p: string): Promise<number> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return s.size;
    let t = 0;
    for (const f of await readdir(p)) t += await size(join(p, f));
    return t;
  } catch { return 0; }
}
const before = await size(join(root, ".."));
for (const d of await readdir(join(root, "napi-v6")).catch(() => [] as string[])) {
  if (!keep.some((k) => d.startsWith(k))) {
    await rm(join(root, "napi-v6", d), { recursive: true, force: true });
    console.log(`pruned ${d}`);
  }
}
const after = await size(join(root, ".."));
console.log(`ort: ${(before / 1048576).toFixed(0)}MB -> ${(after / 1048576).toFixed(0)}MB`);
