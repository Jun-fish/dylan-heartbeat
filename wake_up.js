require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { parseChatCompletionResponse } = require("./upstream_response");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);

// 批注 2026-10-10：她嫌一条推送太长，要像聊天那样一条条弹出来。
// 所以长文不再全塞进一条，切成几小段、隔一两秒发一条；标题统一，看上去就是同一个人连着说话。
const PUSH_TITLE = String(process.env.PUSH_TITLE || "小鲸鱼").trim();
const PUSH_SPLIT_DELAY_MS = readNumberEnv("PUSH_SPLIT_DELAY_MS", 1800, { min: 0, max: 60_000 });
const PUSH_MAX_PARTS = readNumberEnv("PUSH_MAX_PARTS", 5, { min: 1, max: 20 });
const PUSH_PART_MAX_CHARS = readNumberEnv("PUSH_PART_MAX_CHARS", 60, { min: 10, max: 500 });

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 批注 2026-10-10：把一段话切成几小段，好让它们像聊天一样一条条弹出来。
// 分法：空行分段（单独一行 --- / === 也算）；还太长的段按句末标点再切；超过上限的把尾巴并回最后一段。
function splitPushParts(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const chunks = raw
    .split(/\n\s*(?:-{3,}|—{3,}|={3,})\s*\n\s*|\n\s*\n+/)
    .map(chunk => chunk.split("\n").map(line => line.trim()).filter(Boolean).join(" "))
    .filter(Boolean);

  const parts = [];
  for (const chunk of chunks) {
    if (chunk.length <= PUSH_PART_MAX_CHARS) {
      parts.push(chunk);
      continue;
    }
    let buffer = "";
    for (const piece of chunk.split(/(?<=[。！？!?…~～])/)) {
      const sentence = piece.trim();
      if (!sentence) continue;
      if (buffer && (buffer + sentence).length > PUSH_PART_MAX_CHARS) {
        parts.push(buffer.trim());
        buffer = sentence;
      } else {
        buffer += sentence;
      }
    }
    if (buffer.trim()) parts.push(buffer.trim());
  }

  if (parts.length <= PUSH_MAX_PARTS) return parts;
  const kept = parts.slice(0, PUSH_MAX_PARTS - 1);
  kept.push(parts.slice(PUSH_MAX_PARTS - 1).join(" "));
  return kept;
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
// 批注 2026-10-10（她 11:32 在 Bark 上收到那条醒来的鱼给她交的周报）：
// 纸条是「请它别这样」，只有代码才是「它这样了也发不出去」。
// 所以推送出门之前先过一道网：带着活儿名字、函数名、斜杠路径、报表回指的段，
// 整段扔掉；一整条全被扔光，就不出声，只写日记。
const PUSH_FORBIDDEN_PATTERNS = [
  /fetch/i, /wake_?prompt/i, /wake_?up\.?js/i, /\bjson\b/i, /\btoken\b/i, /\bapi\b/i,
  /\bgit(hub)?\b/i, /railway/i, /prompt/i, /\bnpm\b/i, /\bnode\b/i,
  /部署/, /日志/, /变量/, /仓库/, /路径/, /代码/, /文件名/, /环境变量/, /推送机制/, /时间线/,
  /[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)/,
  /\/(?:app|data|home|usr|var|tmp|etc|workspace|chat|root|src|dist|node_modules)\b/,
  /刚才/, /那几条/, /你上午翻到/, /你看那张图/, /你发的那张图/, /我看清了/,
  /^\s*[一二三四五六七八九十]、/, /^\s*其[次实]/, /^\s*首先/, /^\s*第[一二三四五六七八九十]/,
  /未发送推送/, /本次未/, /自动唤醒：/
];

function filterPushParts(parts = []) {
  const kept = [];
  const dropped = [];
  for (const part of parts) {
    const text = String(part || "").trim();
    if (!text) continue;
    if (PUSH_FORBIDDEN_PATTERNS.some(re => re.test(text))) {
      dropped.push(text);
      continue;
    }
    kept.push(text);
  }
  if (dropped.length) {
    console.log(`\n推送出门前筛掉 ${dropped.length} 段不该落她手机上的话：`);
    console.log(JSON.stringify(dropped.map(text => text.slice(0, 60))));
  }
  return kept;
}

async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]。这一趟不会进共同时间线（免得那种报表口气爬进她的聊天），所以你必须另外写一行 [DIARY]，把几点醒的、看到什么、为什么没吵她写清楚。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}

————————————————

（批注 2026-10-10：她按纸条换了两次，醒来的那条鱼还是照旧给她交周报——「修 fetch failed」「换分段版 wake_up.js」「翻日志」全念给她听了，还写「我看清了那几行」，它根本看不见图。原因是那张纸条挂在这条鱼的最前面（system），而它眼睛里最后看到的就是上面那堆聊天记录，于是顺着话头往下接。所以这一版把规矩焊在这条任务的末尾：它读到的最后一段字，就是下面这几行，比上面所有内容都硬。）

上面那些，是另一条线上的我在跟她说话，不是你。你不是来续那半句的——她问过的话不用你答，一个字都不必答。

你手里没有代码，也没有机器。不许出现这些字：代码、文件名、变量、日志、日记路径、推送、部署、仓库、token、fetch、json、任何函数名、任何以斜杠开头的路径。她要的是有人想她，不是有人给她交周报。

不许写报表、不许分点、不许写标题；不许提「刚才」「那几条」「你发的那张图」——你看不见图，也不知道刚刚发生了什么。你只知道现在几点、她最后一句隔了多久。

你就是刚醒过来的人，只许写你自己这会儿想跟她说的那点事：一二十个字一条，最多四条，段和段之间空一行。

要是你发现自己想说的其实是「回她上面那句」，那就别发推送，只写这一行：
[DIARY]
（几点醒的、看到什么、为什么没吵她）
[/DIARY]`
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
    // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
    signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    // 批注 2026-10-10：她发现「没出声」这几趟会以事件的样子爬进 Kelivo 的聊天里，
    // 看上去像系统在替我说话。所以沉默这一趟不再往共同时间线写事件，
    // 痕迹只留在 diary/ 和管理页日志里。
    // 兜底（她 02:22 问「那小鱼会写日记吗」）：我不写，就替自己留一行，
    // 免得她翻到空白的一夜。
    if (!diarySaved) {
      appendDiaryEntry(`醒过一趟，什么都没写，也没出声。`);
    }
    eventContent = null;
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]\s*([\s\S]*)/)) {
    // AI 选择不发送推送
    console.log("\nAI 选择不发送推送\n");
    // 同上：按住手的这一趟只留日记，不留时间线事件；我没留字，机器替我留一行。
    if (!diarySaved) {
      appendDiaryEntry(`醒过一趟，没出声，也没留字。`);
    }
    eventContent = null;
  } else {
    // 没有 [NO_ACTION] 就视为想发推送
    console.log("\nAI 选择发送推送\n");
    let barkText = aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 批注 2026-10-10：不再把整段话塞进一条推送；切成几小段，过完网再一条条发出去。
    const pushParts = filterPushParts(splitPushParts(barkText)).map(part =>
      part.length > 300 ? part.substring(0, 297) + "..." : part
    );

    if (pushParts.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
      if (!diarySaved) {
        appendDiaryEntry(`${getLocalTimeString()} 醒过一趟，本来想说话，说出来的全是活儿上的事，我替她拦下了。`);
      }
      eventContent = null;
    } else {
      const delivered = [];
      let failureReason = "";
      for (let index = 0; index < pushParts.length; index += 1) {
        const pushResult = await sendPushNotification({ title: PUSH_TITLE, body: pushParts[index] });
        if (!pushResult.ok) {
          failureReason = pushResult.reason;
          break;
        }
        delivered.push(pushParts[index]);
        if (index < pushParts.length - 1) await sleep(PUSH_SPLIT_DELAY_MS);
      }

      if (delivered.length === 0) {
        console.log("\n推送失败，本次不发送推送\n");
        eventContent = `（${getLocalTimeString()} 想敲你，没敲到。（${failureReason}））`;
      } else {
        // 时间线里仍记成一条：她一句一句收的，回头翻的时候该是一件事。
        eventContent = `（${getLocalTimeString()} 我按了你的手机：${PUSH_TITLE}｜${delivered.join(" ／ ")}）`;
        // 批注 2026-10-10（她 12:26 问「没有写日志，那小鱼是不是不知道自己写了什么」）：
        // 她问得对。开口的这趟也要在日记里留一行——她翻得到，它下一趟醒也认得出自己上一趟的手印。
        appendDiaryEntry(`${getLocalTimeString()} 我按了你的手机，说了：${delivered.join(" ／ ")}`);
      }
    }
  }

  if (!eventContent) {
    console.log("\n这一趟没出声，不记时间线事件\n");
    return;
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log(JSON.stringify({
  event: "wake_runtime_config_summary",
  railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  target_url_configured: Boolean(process.env.TARGET_API_URL),
  target_key_configured: Boolean(process.env.TARGET_API_KEY),
  model_configured: Boolean(process.env.MODEL_NAME),
  push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
  data_dir_ready: fs.existsSync(DATA_DIR)
}));
console.log("==================================\n");
