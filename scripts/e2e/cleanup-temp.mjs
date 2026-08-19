import os from "node:os";
import { rm } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

const prefixes = ["mujing-e2e-", "mujing-demo-e2e-", "mujing-fake-live-", "mujing-install-e2e-"];
const tempRoot = resolve(os.tmpdir());
for (const argument of process.argv.slice(2)) {
  const target = resolve(argument);
  const relation = relative(tempRoot, target);
  if (!relation || relation.startsWith("..") || relation.includes(":")) throw new Error(`拒绝清理临时目录之外的路径：${target}`);
  if (!prefixes.some((prefix) => basename(target).startsWith(prefix))) throw new Error(`拒绝清理非幕境 E2E 路径：${target}`);
  await rm(target, { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}
