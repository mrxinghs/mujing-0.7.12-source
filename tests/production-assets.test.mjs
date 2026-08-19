import test from "node:test";
import assert from "node:assert/strict";
import {
  createManualProductionAsset,
  deriveProductionAssets,
  normalizeProductionAssets,
  productionAssetPromptBlock,
  productionAssetReferences,
  productionAssetsForShot,
} from "../app/production-assets.mjs";

const characters = [{ id: "hero", name: "主角" }, { id: "father", name: "父亲" }];
const shots = [
  { id: "shot-1", characterIds: ["hero", "father"], scene: "旧厨房", visual: "父亲拿着账单坐在餐桌旁", narration: "父亲看着账单。" },
  { id: "shot-2", characterIds: ["hero"], scene: "旧厨房", visual: "主角收起钱包离开", narration: "他走出了家门。" },
  { id: "shot-3", characterIds: ["hero"], scene: "雨夜街道", visual: "主角撑伞走在街道上", narration: "雨越来越大。" },
];

test("derives stable costumes, scenes and props from the production plan", () => {
  const assets = deriveProductionAssets(shots, characters);
  assert.ok(assets.some((asset) => asset.id === "costume:hero:default"));
  assert.ok(assets.some((asset) => asset.category === "scene" && asset.name === "旧厨房"));
  assert.ok(assets.some((asset) => asset.category === "prop" && asset.name === "票据"));
  assert.ok(assets.some((asset) => asset.category === "prop" && asset.name === "雨伞"));
});

test("preserves edited prompts and reference images while re-deriving automatic assets", () => {
  const first = deriveProductionAssets(shots, characters);
  const edited = first.map((asset) => asset.id === "costume:hero:default" ? { ...asset, prompt: "固定深蓝色外套", referenceImage: "data:image/png;base64,abc" } : asset);
  const next = deriveProductionAssets(shots, characters, edited);
  const heroCostume = next.find((asset) => asset.id === "costume:hero:default");
  assert.equal(heroCostume.prompt, "固定深蓝色外套");
  assert.equal(heroCostume.referenceImage, "data:image/png;base64,abc");
});

test("supports per-shot automatic defaults and manual multi-asset overrides", () => {
  const assets = deriveProductionAssets(shots, characters);
  const automatic = productionAssetsForShot(shots[0], assets);
  assert.ok(automatic.some((asset) => asset.category === "scene"));
  assert.ok(automatic.some((asset) => asset.id === "costume:hero:default"));
  const selected = assets.filter((asset) => ["costume:hero:default", "prop:票据"].includes(asset.id)).map((asset) => asset.id);
  const manual = productionAssetsForShot({ ...shots[0], productionAssetSelectionMode: "manual", productionAssetIds: selected }, assets);
  assert.deepEqual(manual.map((asset) => asset.id), selected);
});

test("builds prompt constraints and ordered de-duplicated image references", () => {
  const assets = normalizeProductionAssets([
    { id: "scene-1", category: "scene", name: "旧厨房", prompt: "固定木桌", generatedImage: "asset://scene" },
    { id: "prop-1", category: "prop", name: "账单", prompt: "旧纸张", referenceImage: "asset://prop" },
    { id: "prop-2", category: "prop", name: "重复账单", referenceImage: "asset://prop" },
  ]);
  assert.match(productionAssetPromptBlock(assets), /场景资产/);
  assert.match(productionAssetPromptBlock(assets), /道具资产/);
  assert.deepEqual(productionAssetReferences(assets).map((item) => item.src), ["asset://scene", "asset://prop"]);
});

test("creates manual library assets with stable production fields", () => {
  const asset = createManualProductionAsset("prop", 3);
  assert.equal(asset.category, "prop");
  assert.equal(asset.name, "道具 3");
  assert.equal(asset.source, "manual");
});
