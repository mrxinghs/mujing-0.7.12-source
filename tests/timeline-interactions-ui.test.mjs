import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("timeline zoom changes the real shared ruler and track content width", () => {
  assert.match(page, /ref=\{timelineViewport\}[\s\S]*onWheel=\{zoomTimelineWithWheel\}/);
  assert.match(page, /ref=\{timelineContent\}[\s\S]*style=\{\{ width: `\$\{timelineZoom\}%` \}\}/);
  assert.match(page, /changeTimelineZoom\(10\)/);
  assert.match(page, /changeTimelineZoom\(-10\)/);
  assert.match(css, /\.timeline-scroll-viewport\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.timeline-content\s*\{[^}]*min-width:\s*760px/);
});

test("wheel zoom stays anchored near the pointer", () => {
  assert.match(page, /function zoomTimelineWithWheel\(event: ReactWheelEvent<HTMLDivElement>\)/);
  assert.match(page, /changeTimelineZoom\(wheelDelta < 0 \? 10 : -10, event\.clientX\)/);
  assert.match(page, /anchorRatio \* newWidth - anchorX/);
});

test("space toggles timeline playback without hijacking text editing or dialogs", () => {
  assert.match(page, /event\.code !== "Space" \|\| event\.repeat \|\| activeStep !== 5/);
  assert.match(page, /input, textarea, select, button, a, \[contenteditable='true'\], \[role='textbox'\]/);
  assert.match(page, /document\.querySelector\("\.modal-backdrop"\)/);
  assert.match(page, /window\.addEventListener\("keydown", togglePlaybackWithSpace\)/);
  assert.match(page, /className="play-button" onClick=\{toggleTimelinePlayback\}/);
});
