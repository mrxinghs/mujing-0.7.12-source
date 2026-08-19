const ROLE_WORDS = ["修表师", "守塔人", "电台记者", "记者", "医生", "老师", "警察", "邮差", "律师", "青年", "少女", "少年", "女孩", "男孩", "老人"];
const AFTER_NAME = "(?=在|正|用|把|带|拿|听|看|说|提|走|来|则|和|与|也|又|仍|已|将|从|向|为|守|接|站|回|保存|[，。！？；、\\s]|$)";

const FIRST_PERSON_PATTERN = /(?:^|[，。！？；：\n])\s*我(?:在|是|也|又|还|曾|从|向|和|与|把|被|将|要|想|看|听|走|站|拿|第一次|小时候|童年|出生|后来|现在|那年|那天|的|，|。|！|？)/;
const CHILD_STAGE_PATTERN = /童年|小时候|儿时|幼年|年幼|少年时期|孩提|小学生|上小学|小男孩|小女孩|年幼的我|童年的我|小时候的我/;
const ADULT_STAGE_PATTERN = /成年|长大后|多年后|后来.*工作|大学毕业|参加工作|成家|结婚|职场|年薪|律师|记者|中年|三十岁|四十岁|成年后的我|成年叙述者/;
const ELDER_STAGE_PATTERN = /老年|晚年|退休后|年迈|六十岁|七十岁|暮年/;

export function inferNamedCharacters(text) {
  const names = [];
  const add = (name) => {
    const normalized = String(name || "").trim();
    if (normalized && !/^(?:的|了|着|和|与|在|把|将|则|也|又|仍)/.test(normalized) && !ROLE_WORDS.includes(normalized) && !names.includes(normalized)) names.push(normalized);
  };
  const rolePattern = new RegExp(`(?:${ROLE_WORDS.join("|")})([\\u4e00-\\u9fa5]{2,4}?)${AFTER_NAME}`, "g");
  for (const match of String(text || "").matchAll(rolePattern)) add(match[1]);
  for (const match of String(text || "").matchAll(/(?:名叫|叫做|叫)([\u4e00-\u9fa5]{2,4})(?=[，。！？、\s]|$)/g)) add(match[1]);
  return names;
}

export function inferPrimaryCharacterName(text) {
  const named = inferNamedCharacters(text);
  if (named[0]) return named[0];
  if (FIRST_PERSON_PATTERN.test(String(text || ""))) return "叙述者";
  const role = String(text || "").match(new RegExp(`(?:一名|一位|一个|那位|这位)?(${ROLE_WORDS.join("|")})`));
  return role?.[1] ?? "";
}

export function inferCharacterStages(text) {
  const value = String(text || "");
  const stages = [];
  if (CHILD_STAGE_PATTERN.test(value)) stages.push("child");
  if (ADULT_STAGE_PATTERN.test(value)) stages.push("adult");
  if (ELDER_STAGE_PATTERN.test(value)) stages.push("elder");
  if (!stages.length) stages.push("adult");
  return stages;
}

export function inferCharacterStage(text, availableStages = []) {
  const value = String(text || "");
  if (CHILD_STAGE_PATTERN.test(value)) return "child";
  if (ELDER_STAGE_PATTERN.test(value)) return "elder";
  if (ADULT_STAGE_PATTERN.test(value)) return "adult";
  if (availableStages.length === 1) return availableStages[0];
  return availableStages.includes("adult") ? "adult" : availableStages[0] || "adult";
}

export function inferPrimaryCharacterProfile(text) {
  const value = String(text || "");
  const name = inferPrimaryCharacterName(value) || "主要人物";
  const firstPerson = FIRST_PERSON_PATTERN.test(value);
  const stages = inferCharacterStages(value);
  const aliases = [name];
  if (firstPerson) aliases.push("我", "叙述者", "主角");
  if (firstPerson && stages.includes("child")) aliases.push("年幼的我", "童年的我", "少年时期的叙述者");
  if (firstPerson && stages.includes("adult")) aliases.push("成年后的我", "成年叙述者");
  if (firstPerson && stages.includes("elder")) aliases.push("老年的我", "老年叙述者");
  return { name, aliases: [...new Set(aliases)], stages, firstPerson };
}

export function inferSecondaryCharacterName(text, primaryName) {
  const named = inferNamedCharacters(text);
  const secondNamed = named.find((name) => name !== primaryName);
  if (secondNamed) return secondNamed;
  if (/红门[^。！？]*女孩/.test(text) && primaryName !== "红门女孩") return "红门女孩";
  const roles = [...String(text || "").matchAll(new RegExp(`(?:一名|一位|一个|那位|这位)?(${ROLE_WORDS.join("|")})`, "g"))].map((match) => match[1]);
  return roles.find((role) => role !== primaryName) ?? "";
}
