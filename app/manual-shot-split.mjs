function clean(value) {
  return String(value || "").trim();
}

function sentencePieces(text) {
  return clean(text).match(/[^。！？!?；;\n]+[。！？!?；;]?/g)?.map(clean).filter(Boolean) || [];
}

export function suggestShotSplit(narration) {
  const source = clean(narration);
  if (!source) return { first: "", second: "" };
  const pieces = sentencePieces(source);
  if (pieces.length > 1) {
    const midpoint = Array.from(source).length / 2;
    let length = 0;
    let boundary = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < pieces.length - 1; index += 1) {
      length += Array.from(pieces[index]).length;
      const distance = Math.abs(length - midpoint);
      if (distance < bestDistance) { bestDistance = distance; boundary = index + 1; }
    }
    return { first: pieces.slice(0, boundary).join(""), second: pieces.slice(boundary).join("") };
  }

  const characters = Array.from(source);
  const preferred = characters
    .map((character, index) => ({ character, index }))
    .filter(({ character, index }) => /[，,、：:]/.test(character) && index > 0 && index < characters.length - 1)
    .sort((left, right) => Math.abs(left.index - characters.length / 2) - Math.abs(right.index - characters.length / 2))[0];
  const boundary = preferred ? preferred.index + 1 : Math.max(1, Math.min(characters.length - 1, Math.round(characters.length / 2)));
  return { first: characters.slice(0, boundary).join("").trim(), second: characters.slice(boundary).join("").trim() };
}

export function splitTextMatchesSource(source, first, second) {
  const normalize = (value) => Array.from(String(value || "")).filter((character) => !/\s/.test(character)).join("");
  return normalize(source) === normalize(`${first}${second}`);
}

export function allocateSplitDurations(totalDuration, first, second) {
  const total = Math.max(0.2, Number(totalDuration) || 0.2);
  const firstLength = Math.max(1, Array.from(clean(first)).length);
  const secondLength = Math.max(1, Array.from(clean(second)).length);
  const minimum = Math.min(1.2, total / 2);
  const proportional = total * (firstLength / (firstLength + secondLength));
  const firstDuration = Number(Math.max(minimum, Math.min(total - minimum, proportional)).toFixed(3));
  return [firstDuration, Number((total - firstDuration).toFixed(3))];
}

export function reflowShotTimeline(shots) {
  let cursor = 0;
  return shots.map((shot) => {
    const duration = Math.max(0.1, Number(shot.duration) || 0.1);
    const next = { ...shot, duration, start: Number(cursor.toFixed(3)), end: Number((cursor + duration).toFixed(3)) };
    cursor += duration;
    return next;
  });
}
