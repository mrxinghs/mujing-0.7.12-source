function narrationWeight(text) {
  const value = String(text || "").replace(/\s/g, "");
  const spoken = [...value.replace(/[，。！？；：、,.!?;:]/g, "")].length;
  const pauses = (value.match(/[，、,]/g) || []).length * 0.45
    + (value.match(/[。！？；：.!?;:]/g) || []).length * 0.9;
  return Math.max(1, spoken + pauses);
}

function distributeWithCaps(weights, total, caps, minimum) {
  const durations = weights.map(() => minimum);
  let remaining = Math.max(0, total - minimum * weights.length);
  const open = new Set(weights.map((_, index) => index));
  while (remaining > 0.000001 && open.size) {
    const openWeight = [...open].reduce((sum, index) => sum + weights[index], 0) || open.size;
    let consumed = 0;
    for (const index of [...open]) {
      const share = remaining * (weights[index] / openWeight);
      const cap = caps?.[index] ?? Number.POSITIVE_INFINITY;
      const room = Math.max(0, cap - durations[index]);
      const addition = Math.min(share, room);
      durations[index] += addition;
      consumed += addition;
      if (room <= share + 0.000001) open.delete(index);
    }
    if (consumed <= 0.000001) break;
    remaining -= consumed;
  }
  return { durations, remaining };
}

export function alignShotsToVoice(shots, voiceDuration, options = {}) {
  const duration = Number(voiceDuration);
  if (!Array.isArray(shots) || !shots.length || !Number.isFinite(duration) || duration <= 0) return { ok: false, reason: "缺少可用于对齐的镜头或配音时长。", shots };
  const weights = shots.map((shot) => narrationWeight(shot.narration));
  const minimum = Math.min(0.8, Math.max(0.05, duration / shots.length / 3));
  const caps = options.preserveExistingVideoLengths ? shots.map((shot) => Math.max(minimum, Number(shot.duration) || minimum)) : undefined;
  const distributed = distributeWithCaps(weights, duration, caps, minimum);
  if (distributed.remaining > 0.02) return { ok: false, reason: "配音比现有视频时间线更长，无法在不延长已生成视频的情况下自动对齐。", shots };
  const rounded = distributed.durations.map((value) => Math.round(value * 1000) / 1000);
  const roundedTotal = rounded.reduce((sum, value) => sum + value, 0);
  rounded[rounded.length - 1] = Math.max(0.05, Math.round((rounded[rounded.length - 1] + duration - roundedTotal) * 1000) / 1000);
  let cursor = 0;
  const aligned = shots.map((shot, index) => {
    const itemDuration = rounded[index];
    const start = Math.round(cursor * 1000) / 1000;
    cursor += itemDuration;
    const end = index === shots.length - 1 ? duration : Math.round(cursor * 1000) / 1000;
    return { ...shot, duration: Math.round((end - start) * 1000) / 1000, start, end };
  });
  return { ok: true, shots: aligned, totalDuration: duration };
}

