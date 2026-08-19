import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("all five creation steps share one adaptive wide workspace", () => {
  assert.match(css, /--workspace-max:\s*1760px/);
  for (const selector of [
    ".workspace-heading",
    ".editor-grid",
    ".character-layout",
    ".storyboard-list",
    ".generation-grid",
    ".preview-layout",
    ".timeline-panel",
  ]) {
    assert.ok(css.includes(selector), `missing adaptive selector ${selector}`);
  }
});

test("character, generation and preview pages collapse cleanly on narrow windows", () => {
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*?\.editor-grid,[\s\S]*?\.character-layout,[\s\S]*?\.generation-grid,[\s\S]*?\.preview-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.character-portrait\s*\{[\s\S]*?aspect-ratio:\s*9 \/ 14/);
  assert.match(css, /\.player-frame\s*\{\s*height:\s*clamp\(360px, 34vw, 650px\)/);
});

test("small interface copy uses a balanced readable type scale", () => {
  assert.match(css, /--type-small:\s*clamp\(12px,[^;]+14px\)/);
  assert.match(css, /--type-micro:\s*clamp\(11px,[^;]+13px\)/);
  assert.match(css, /\.sidebar-heading,[\s\S]*?\.health-row,[\s\S]*?\.project-health p,[\s\S]*?font-size:\s*var\(--type-small\)/);
});

test("generation cards separate providers, descriptions, states and actions into visual zones", () => {
  assert.match(css, /\.generation-toolbar \.provider-pill:nth-child\(1\)[^}]*background:\s*#edf7f2/);
  assert.match(css, /\.generation-toolbar \.provider-pill:nth-child\(2\)[^}]*background:\s*#f5f1f8/);
  assert.match(css, /\.generation-card-body > p\s*\{[^}]*border-left:\s*3px solid[^}]*background:\s*#f7f9f7/);
  assert.match(css, /\.generation-actions\s*\{[^}]*border-top:\s*1px solid/);
});

test("desktop workflow navigation and its utility links stay visible while the workspace scrolls", () => {
  assert.match(css, /\.app-shell\s*\{[^}]*height:\s*100vh[^}]*grid-template-rows:\s*68px minmax\(0, 1fr\)[^}]*overflow:\s*hidden/);
  assert.match(css, /\.sidebar\s*\{[^}]*min-height:\s*0[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-column:\s*2[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
  assert.match(css, /@media \(min-width: 1051px\)[\s\S]*?\.app-shell\s*\{[^}]*grid-template-rows:\s*78px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.app-shell\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/);
});

test("workflow progress floats at the work-area bottom without reserving card space", () => {
  assert.match(css, /\.sticky-next\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.storyboard-list\s*\{[^}]*margin:\s*0 auto;/s);
  assert.match(css, /\.generation-grid\s*\{[^}]*margin:\s*0 auto;/s);
});
