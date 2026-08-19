import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("the visible version comes from Electron package metadata instead of a stale UI literal", () => {
  assert.match(main, /ipcMain\.handle\("app:version", \(\) => app\.getVersion\(\)\)/);
  assert.match(preload, /getAppVersion: \(\) => ipcRenderer\.invoke\("app:version"\)/);
  assert.match(page, /window\.mujingDesktop\.getAppVersion\(\)/);
  assert.match(page, /<span className="brand-tag">\{appVersion\}<\/span>/);
  assert.doesNotMatch(page, /className="brand-tag">0\.4\.0/);
});
