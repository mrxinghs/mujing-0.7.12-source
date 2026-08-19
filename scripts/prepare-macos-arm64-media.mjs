import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const assets = [
  {
    name: "ffmpeg",
    url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz",
    gzipSha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  },
  {
    name: "ffprobe",
    url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz",
    gzipSha256: "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be",
  },
];

const outputDir = path.resolve("build", "macos-arm64");
await fs.mkdir(outputDir, { recursive: true });

for (const asset of assets) {
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${asset.name} 下载失败：HTTP ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(compressed).digest("hex");
  if (digest !== asset.gzipSha256) throw new Error(`${asset.name} SHA-256 校验失败`);
  const destination = path.join(outputDir, asset.name);
  await fs.writeFile(destination, gunzipSync(compressed), { mode: 0o755 });
  await fs.chmod(destination, 0o755);
  process.stdout.write(`${asset.name}: verified ${digest}\n`);
}