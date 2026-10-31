// 请求路由：模型判断为主，启发式兜底（无凭证/失败不阻塞启动）——v1.9 起附带 tier/CLARIFY 豁免判定（契约 20/21）
import type { PathId, Tier } from "./types";

export interface RouteResult {
  /** 工作路径或 "chat"（闲聊放行：pi 原生会话直接回答，不建 run 不落产物，T27） */
  path: PathId | "chat";
  /** 风险分级（契约 20，仅 feature 消费）：缺省 t1 常规全链 */
  tier: Tier;
  /** CLARIFY 豁免（契约 21）：需求证据完整（附验收/复现/明确规格）则 true，缺省 false */
  waive: boolean;
  /** 需求标题（≤12字动宾短语，模型归纳；失败时本地修饰兑底）——runId 与台账展示用，原话保留于 request */
  title: string;
  /** 承接上一轮（契约 24/A）：仅当调用方提供 lastRun 上下文时才可能为 true——追问/深化/据其行动 */
  followUp?: boolean;
  reason: string;
  by: "model" | "heuristic" | "prefix";
}

const RESEARCH_KW = /调研|调查|研究|对比|选型|可行性|分析一下|方案比较|research|compare|evaluate|survey/i;
const BUGFIX_KW = /修复|修一下|改好|bug|报错|错误|崩溃|异常|不工作|不刷新|失败|挂了|fix|broken|crash|error/i;
const PRD_KW = /prd|需求文档|产品需求文档|写份?需求/i;
const T0_KW = /补个?(测试|用例)|改.{0,4}(文案|错别字|注释)|(文案|错别字)有?(错|要改)|typo|小改一?点?/i;
const T2_KW = /认证|鉴权|加密|数据迁移|公共契约|安全审查|影响\s*(3|三)\s*个?(以上)?模块/i;
const WAIVE_KW = /验收标准|验收命令|复现步骤|复现命令|acceptance\s*criteria|无需澄清|不用问/i;
const CHAT_KW = /^(你好|您好|hi|hello|hey|在吗|谢谢|多谢|感谢|好的|嗯+|ok|okay|收到|再见|拜拜|辛苦了)[!！。.~～\s]*$/i; // 整句精确匹配才放行——含工作意图不误伤
const FOLLOWUP_KW = /这个|上述|上面|刚才|上一?轮|据此|接着|深入|在其?基础上|按这个/; // 契约 24/A 兜底：指代词命中且存在上轮才承接

/** 本地标题修饰兑底（无模型/失败时）：剥前缀语气词 → 取首语义段 → 截 16 字（英文按词边界，避免半截词）；空则退回原文前 16 字。 */
export function polishTitle(request: string): string {
  let t = request
    .trim()
    .replace(/^(我想|我要|帮我|麻烦|请|给我|能不能|可以|是不是|顺便|现在)+/, "");
  t = (t.split(/[。！？!?，,;；\n··]/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (!t) t = request.trim();
  if (t.length <= 16) return t;
  t = t.slice(0, 16);
  const sp = t.lastIndexOf(" ");
  return sp > 6 ? t.slice(0, sp) : t;
}

/** 启发式路由：chat（整句问候/闲聊）→ research 优先 → prd → bugfix → 默认 feature；tier 存疑就高；标题本地修饰兑底。 */
export function heuristicRoute(request: string): RouteResult {
  const tier: Tier = T2_KW.test(request) ? "t2" : T0_KW.test(request) ? "t0" : "t1";
  const waive = WAIVE_KW.test(request);
  const title = polishTitle(request);
  if (CHAT_KW.test(request.trim())) return { path: "chat", tier, waive, title, reason: "问候/闲聊，直接对话", by: "heuristic" };
  if (RESEARCH_KW.test(request)) return { path: "research", tier, waive, title, reason: "命中调研类关键词", by: "heuristic" };
  if (PRD_KW.test(request)) return { path: "prd", tier, waive, title, reason: "命中 PRD 类关键词", by: "heuristic" };
  if (BUGFIX_KW.test(request)) return { path: "bugfix", tier, waive, title, reason: "命中修复类关键词", by: "heuristic" };
  return { path: "feature", tier, waive, title, reason: "默认：新功能/改动", by: "heuristic" };
}

/** 前缀强制：'1 xxx'→feature '2 xxx'→bugfix '3 xxx'→research '4 xxx'→prd。 */
export function parsePrefix(request: string): { path?: PathId; text: string } {
  const m = /^([1-4])\s+(.+)$/s.exec(request.trim());
  if (!m) return { text: request };
  const path = (["feature", "bugfix", "research", "prd"] as const)[Number(m[1]) - 1];
  return { path, text: m[2].trim() };
}

/** 模型路由：一次性小会话，失败抛错由上层兜底。 */
export async function classifyWithModel(
  request: string,
  ctx?: { lastRun?: { runId: string; request: string } },
): Promise<RouteResult> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const { session } = await pi.createAgentSession({ sessionManager: pi.SessionManager.inMemory() });
  try {
    await session.prompt(
      [
        "把下面的用户请求分类为五选一，只依据请求本身判断：",
        "feature=做新功能或改动代码；bugfix=修复问题/报错/异常；research=只读调研分析，不改代码；prd=只产出需求文档（PRD），不写代码；chat=闲聊/问候/致谢/与开发工作无关的对话，或一句话可直接回答的简单提问（无需产出文档或改代码）。",
        "存疑就工作不闲聊：拿不准 chat 还是 research/prd 时，选 research/prd。",
        "同时判断（仅 feature 需要，其余路径照填 t1/no）：",
        "tier: t0=单文件微改动/补测试/改文案；t2=触达认证/加密/数据迁移/公共契约；t1=其余常规；存疑就高不就低",
        "waive: yes=需求已含验收标准/复现命令等完整证据无需澄清；no=仍需澄清",
        "title: 不超过12字的动宾短语标题（如「抽取通用开发框架」），概括需求目标，禁止照抄原话",
        ...(ctx?.lastRun
          ? [
              `上一轮已完成的需求（可能被承接）：${ctx.lastRun.request.slice(0, 80)}`,
              "followup: yes=本请求承接上一轮（追问/深化/据其行动/在其产物上继续）；no=独立新任务；默认 no",
            ]
          : []),
        `请求：${request}`,
        ctx?.lastRun
          ? '只输出如下六行，不要其他内容：\npath: feature|bugfix|research|prd|chat\ntier: t0|t1|t2\nwaive: yes|no\ntitle: 短语\nfollowup: yes|no\nreason: 不超过15字的理由'
          : '只输出如下五行，不要其他内容：\npath: feature|bugfix|research|prd|chat\ntier: t0|t1|t2\nwaive: yes|no\ntitle: 短语\nreason: 不超过15字的理由',
      ].join("\n"),
    );
    const text = session.getLastAssistantText() ?? "";
    const path = /path:\s*(feature|bugfix|research|prd|chat)/i.exec(text)?.[1]?.toLowerCase() as RouteResult["path"] | undefined;
    const tierRaw = /tier:\s*(t[012])/i.exec(text)?.[1]?.toLowerCase();
    const tier: Tier = tierRaw === "t0" || tierRaw === "t2" ? tierRaw : "t1"; // 不可解析→保守 t1
    const waive = /waive:\s*yes/i.test(text);
    const title = /title:\s*(.+)/i.exec(text)?.[1]?.trim().slice(0, 24) || polishTitle(request); // 模型丢行→本地修饰兑底
    const followUp = ctx?.lastRun ? /followup:\s*yes/i.test(text) : undefined; // 无上轮上下文则不判承接
    const reason = /reason:\s*(.+)/i.exec(text)?.[1]?.trim().slice(0, 30) ?? "";
    if (!path) throw new Error("路由输出不可解析");
    return { path, tier, waive, title, ...(followUp === undefined ? {} : { followUp }), reason: reason || "模型判断", by: "model" };
  } finally {
    session.dispose();
  }
}

/** 路由入口：前缀强制 > 模型判断 > 启发式兜底；无 git 目录强制降级 research（代码路径需 worktree）。 */
export async function routeRequest(
  request: string,
  classify: (req: string, ctx?: { lastRun?: { runId: string; request: string } }) => Promise<RouteResult> = classifyWithModel,
  opts: { allowCodePaths?: boolean; lastRun?: { runId: string; request: string } } = {},
): Promise<RouteResult & { text: string }> {
  const { path, text } = parsePrefix(request);
  if (path) return { path, reason: "前缀指定", by: "prefix", tier: "t1", waive: false, title: polishTitle(text), text }; // 前缀是明确意志：tier 不猜，标题本地修饰
  let r: RouteResult;
  try {
    r = await classify(text, { lastRun: opts.lastRun });
  } catch {
    r = heuristicRoute(text);
    if (opts.lastRun && FOLLOWUP_KW.test(text)) r = { ...r, followUp: true }; // 兜底：有上轮 + 指代词命中才承接
  }
  if (opts.allowCodePaths === false && r.path !== "research" && r.path !== "prd" && r.path !== "chat") {
    return { path: "research", tier: "t1", waive: false, title: r.title, reason: "当前目录无 git，仅调研/PRD 路径可用（feature/bugfix 需隔离分支）", by: "heuristic", text };
  }
  return { ...r, title: r.title || polishTitle(text), text }; // 分类器丢 title→本地修饰兑底（不信任空标题）
}
