const path = require("node:path");

function resolveE2EExportPath({ isPackaged, enabled, outputPath }) {
  if (isPackaged || enabled !== "1" || !String(outputPath || "").trim()) return "";
  return path.resolve(String(outputPath));
}

module.exports = { resolveE2EExportPath };
