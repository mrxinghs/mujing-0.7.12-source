function stableIndex(value, size) {
  let hash = 2166136261;
  for (const character of String(value || "")) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return Math.abs(hash >>> 0) % size;
}

export function createDemoCharacterDescription({ name, script }) {
  const identityText = `${name || ""}${script || ""}`;
  const hasChildStage = /童年|小时候|儿时|幼年|年幼|少年时期|孩提|小学生/.test(identityText);
  const hasAdultStage = /成年|长大后|多年后|工作|大学|结婚|职场|年薪|律师|记者|中年/.test(identityText);
  const identity = hasChildStage && hasAdultStage
    ? "同一位东亚人物的童年与成年两个年龄阶段，只做自然年龄变化"
    : /老人|老者|爷爷|奶奶/.test(identityText)
    ? "约六十岁的东亚长者"
    : /女孩|姑娘|少女|女人|女士|母亲/.test(identityText)
      ? "约二十八岁的东亚女性"
      : /男孩|青年|男人|先生|父亲|记者|邮差|悟空/.test(identityText)
        ? "约三十岁的东亚男性"
        : "约三十岁的东亚成年人，气质中性而清晰";
  const faces = ["清晰的椭圆脸与平直眉形，深棕色眼睛", "略窄的脸型与高眉骨，沉静深色眼睛", "轮廓分明的方圆脸，温和但专注的眼神"];
  const hair = /古代|王朝|宫|剑|妖|仙|天庭|悟空/.test(identityText)
    ? ["深色长发束起，发际线和鬓角固定", "深棕色半束长发，额前无碎发", "利落高束发型，固定深黑发色"]
    : ["深黑短发，三七分，鬓角整洁", "深棕色齐耳短发，发尾自然内收", "黑色微卷短发，额前发束位置固定"];
  const outfits = /记者/.test(identityText)
    ? ["深卡其色记者夹克、米白衬衫，胸前固定一枚记者证", "藏蓝色短夹克、灰色衬衫，斜挎小型采访包"]
    : /古代|王朝|宫|剑|妖|仙|天庭|悟空/.test(identityText)
      ? ["深青与暗金配色的长袍，固定窄腰带和护腕", "墨蓝色交领长衣，固定米白内衬与深色腰封"]
      : ["深墨绿色外套、米白上衣与深灰长裤，服装剪裁简洁", "藏蓝色短风衣、浅灰内搭与黑色长裤，配色克制"];
  const seed = `${name}|${script}`;
  const ageContinuity = hasChildStage && hasAdultStage
    ? "童年与成年必须共享眼型、鼻型、唇形、脸部骨骼、发色和标志性神态；只允许年龄、身高、体型成熟度和阶段服装自然变化"
    : "固定面部轮廓、五官比例、发型发色、体型、服装配色和随身物品";
  return `${name}，${identity}；${faces[stableIndex(seed, faces.length)]}；${hair[stableIndex(`${seed}-hair`, hair.length)]}；${outfits[stableIndex(`${seed}-outfit`, outfits.length)]}。${ageContinuity}，所有镜头保持为同一个人。`;
}
