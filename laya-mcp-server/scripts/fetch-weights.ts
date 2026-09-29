import { homedir } from "os";
import { join } from "path";

// Resumable fetch for laya.onnx.data (HF CDN drops long connections).
// Usage: bun scripts/fetch-weights.ts
const REPO = "receptron/laya-onnx";
const FILES = ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];
const dir = join(process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya"), REPO.replace("/", "--"), "main");

async function headSize(url: string): Promise<number> {
  const r = await fetch(url, { method: "HEAD", redirect: "follow" });
  const v = r.headers.get("x-linked-size") ?? r.headers.get("content-length");
  return Number(v);
}

async function dlOne(file: string) {
  const url = `https://huggingface.co/${REPO}/resolve/main/${file}`;
  const dest = join(dir, file);
  await Bun.$`mkdir -p ${join(dir, file, "..")}`.quiet().catch(() => {});
  const { mkdir } = await import("fs/promises");
  await mkdir(join(dir, file.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => {});
  const total = await headSize(url);
  let have = 0;
  try { have = (await Bun.file(dest).arrayBuffer()).byteLength; } catch { have = 0; }
  if (have === total && total > 0) { console.log(`ok ${file} (${(have / 1048576).toFixed(0)}MB)`); return; }
  console.log(`fetch ${file}: have ${(have / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB`);
  let start = have;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch(url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {}, redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`http ${r.status}`);
      const ws = Bun.file(dest).writer();
      // NOTE: Bun writer truncates; seek by re-writing is not supported -> use node append
      const { createWriteStream } = await import("fs");
      const { Readable } = await import("stream");
      const mode = start > 0 ? { flags: "a" } : {};
      const stream = createWriteStream(dest, mode as any);
      let got = start;
      let last = Date.now();
      for await (const chunk of Readable.fromWeb(r.body as any)) {
        await new Promise<void>((res, rej) => stream.write(chunk, (e: any) => (e ? rej(e) : res())));
        got += (chunk as Buffer).length;
        if (Date.now() - last > 10000) { last = Date.now(); console.log(`... ${file} ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB`); }
      }
      await new Promise<void>((res) => stream.end(() => res()));
      ws.unref?.();
      const final = (await Bun.file(dest).arrayBuffer()).byteLength;
      if (final === total || total <= 0) { console.log(`done ${file}`); return; }
      start = final;
    } catch (e: any) {
      console.log(`retry ${attempt + 1}/10 ${file}: ${String(e?.message || e).slice(0, 100)}`);
      try { start = (await Bun.file(dest).arrayBuffer()).byteLength; } catch { start = 0; }
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(`gave up ${file}`);
}

for (const f of FILES) await dlOne(f);
console.log("all bundle files present");
