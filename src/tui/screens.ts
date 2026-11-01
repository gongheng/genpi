// 聊天消息格式化纯函数（state → string，可测；app.ts 嵌入 pi InteractiveMode 呈现）。
// 契约：不出现任何"选项/编号"语义——路径由模型自动判断，用户只管描述需求。
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { GateScreenState } from "../types";

export interface HeaderState {
  version: string;
  projectDir: string;
  hasGit: boolean;
}

const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[22m`;
const ACCENT = (s: string) => `\x1b[36m${s}\x1b[39m`;

/** 头部：版本 + 项目目录 + git 状态 + 最少按键提示（pi 风格：信息在头部，不占对话流）。 */
export function renderHeader(s: HeaderState): string {
  return [
    `${BOLD("genpi")} ${DIM(s.version)} · ${s.projectDir} ${s.hasGit ? DIM("git ✓") : DIM("git ✗（仅调研类可跑）")}`,
    DIM("回车提交 · Ctrl-C 安全退出"),
  ].join("\n");
}

/** 首条欢迎消息：说明 genpi 做什么，不给路径选项。 */
export function renderWelcome(): string {
  return [
    `${ACCENT("genpi")} — 机器强制的开发循环。`,
    DIM("直接描述你的需求或问题，genpi 自动编排澄清 → 设计 → 计划 → 实施 → 验证，关键节点等你审批。"),
  ].join("\n");
}

/** 路由结果一行（进度信息，非选项）。 */
export function fmtRoute(
  path: string,
  reason: string,
  by: "model" | "heuristic" | "prefix",
  extra?: { tier?: string; waive?: boolean; title?: string; followUp?: boolean },
): string {
  const how = by === "model" ? "模型判断" : by === "prefix" ? "手动指定" : "启发式";
  const bits = [` ${how} · ${reason} `];
  if (extra?.followUp) bits.push("承接上一轮（契约 24） ");
  if (extra?.tier && extra.tier !== "t1") bits.push(`风险分级 ${extra.tier.toUpperCase()}（短链/强化注入，契约 20） `);
  if (extra?.waive && path === "feature" && extra.tier !== "t0") bits.push("需求证据完整，豁免澄清（契约 21） "); // 仅真有 CLARIFY 可豁免的链路展示（T23：t0 短链/research/prd 无 CLARIFY，不显示无效豁免）
  return `${DIM("路线")} ${BOLD(path)}${extra?.title ? DIM(`「${extra.title}」`) : ""} ${DIM(`（${bits.join(" · ").trim()}）`)}`;
}

/** 门禁操作提示（一行）：聊天命令驱动，无模态弹窗（防误触）。 */
export function gateHint(): string {
  return DIM("回复 a 批准 · c <修改意见> 要求修改 · r 终止 · p 预览内容");
}

/** 门禁块：首门禁两行（含 a/c/r/p 教学），此后一行紧凑——不倒产物正文，预览用 p 按需拉取（T26）。 */
export function renderGateBlock(s: GateScreenState, showHint = true): string {
  const head = `${ACCENT("⏸ GATE")} ${BOLD(s.gate)} ${DIM("· 审批对象: " + s.artifact)}`;
  return showHint ? [head, gateHint()].join("\n") : head;
}

/** /genpi log：phase-history 尾部格式化（一行一事件：时分秒 from→to event · note）——T30 观测性。 */
export function formatHistoryLines(rawLines: string[], n = 15): string {
  const entries = rawLines
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { ts?: string; from?: string; to?: string; event?: string; note?: string; budgetLeft?: number }];
      } catch {
        return [];
      }
    })
    .slice(-n);
  if (entries.length === 0) return "（无历史记录）";
  return entries
    .map((e) => {
      const t = (e.ts ?? "").slice(11, 19) || "??:??:??";
      const budget = typeof e.budgetLeft === "number" ? ` budget=${e.budgetLeft}` : "";
      const note = e.note ? ` · ${String(e.note).slice(0, 60)}` : "";
      return `${t} ${e.from ?? "?"}→${e.to ?? "?"} ${e.event ?? "?"}${budget}${note}`;
    })
    .join("\n");
}

/** 边界截断（T34）：限长内找最后一个标点/空格切齐，避免切在引号/括号中间；无处可切才硬切。 */
export function cutBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const b = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"), head.lastIndexOf("，"), head.lastIndexOf("、"), head.lastIndexOf("）"), head.lastIndexOf("」"), head.lastIndexOf("\""), head.lastIndexOf(" "), head.lastIndexOf("\u201c"), head.lastIndexOf("\u201d"));
  return b >= Math.floor(max * 0.5) ? head.slice(0, b + 1) : head.slice(0, max);
}

/** 步末一行摘要（聊天流）：✓/✗ 状态 · summary 首行边界截断 · 落盘产物指路（T26/T34，叙事不归档）。 */
export function fmtStepDigest(state: string, ok: boolean, summary?: string, artifacts?: string[]): string {
  const head = `${ok ? "✓" : "✗"} ${state}`;
  const first = (summary ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  const gist = first ? cutBoundary(first, 40) : "";
  const ell = first && first.length > 40 ? "…" : "";
  const files = artifacts && artifacts.length > 0 ? `（→ ${(artifacts.length > 2 ? artifacts.slice(0, 2).concat(["…"]) : artifacts).join("、")}）` : "";
  return `${head}${gist ? ` · ${gist}${ell}` : ""}${files}`;
}

// ---------- 步骤实时视图（编辑器上方小部件：思考 / 工具 / 文本尾部） ----------

export interface StepLiveState {
  state: string;
  /** 已完成行（按 \n 切分）；partial 为未收到换行的尾部。 */
  thinking: string[];
  thinkingPartial: string;
  text: string[];
  textPartial: string;
  tools: { name: string; detail: string }[];
  lastKind: "text" | "thinking" | "tool" | null;
}

const MAX_LINES = 300; // 长步骤内存封顶（只展示尾部）

export function createStepLiveState(state = ""): StepLiveState {
  return { state, thinking: [], thinkingPartial: "", text: [], textPartial: "", tools: [], lastKind: null };
}

/** 增量入缓冲：按 \n 切行，未完行留 partial——修复逐 delta 成行导致的单字堆叠。 */
export function applyDelta(s: StepLiveState, kind: "text" | "thinking", delta: string): void {
  s.lastKind = kind;
  const lines = kind === "text" ? s.text : s.thinking;
  const partialKey = kind === "text" ? "textPartial" : "thinkingPartial";
  let buf = (s[partialKey] as string) + delta;
  const parts = buf.split("\n");
  s[partialKey] = parts.pop() ?? "";
  for (const l of parts) lines.push(l);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export const stripAnsi = (l: string): string => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

/** 小部件渲染：状态行 + 思考尾部（暗色，6 行）+ 工具聚合计数（一行）+ 文本尾部；全部按视觉行截断。 */
export function renderStepLiveView(s: StepLiveState, width: number): string[] {
  const w = Math.max(24, width - 2);
  const out: string[] = [];
  const thinkingActive = s.lastKind === "thinking";
  out.push(`${DIM(thinkingActive ? "◌" : "●")} ${BOLD(s.state || "…")}${DIM(thinkingActive ? " · 思考中…" : " · 执行中")}`);
  const thinkText = [...s.thinking.slice(-8), s.thinkingPartial].filter((l) => l.trim()).join("\n");
  if (thinkText) {
    out.push(DIM("┆ 思考"));
    out.push(...truncateToVisualLines(thinkText, 6, w, 0, "end").visualLines.map(DIM)); // 思考是主角：6 行（T25，原 4 行）
  }
  if (s.tools.length > 0) {
    // 工具不逐条列（用户关注思考而非工具，T25）：聚合计数一行摘要，详情不入屏
    const counts = new Map<string, number>();
    for (const t of s.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const summary = [...counts.entries()].map(([n, c]) => `${n}×${c}`).join(" · ");
    out.push(DIM(`🛠 ${summary}`.slice(0, Math.max(24, w + 20))));
  }
  const textAll = stripResultBlock([...s.text, s.textPartial].join("\n"));
  if (textAll.trim()) {
    out.push(...truncateToVisualLines(textAll, 6, w, 0, "end").visualLines);
  }
  return out;
}

/** 剥离结尾的结构化结果块（```yaml ok/summary/artifacts/evidence…）——机器协议不入屏。 */
export function stripResultBlock(text: string): string {
  const idx = text.lastIndexOf("\n```yaml");
  if (idx >= 0) return text.slice(0, idx);
  if (text.trimStart().startsWith("```yaml")) return "";
  return text.replace(/\n?```\s*$/, ""); // 游离结束围栏
}

/** 步末归档摘要（入聊天流的消息体）：文本尾部若干完整行（已剥离结果块）。 */
export function stepFlushText(s: StepLiveState, maxLines = 20): string {
  const stripped = stripResultBlock([...s.text, s.textPartial].join("\n"));
  const lines = stripped.split("\n").filter((l, i, arr) => l.trim() || i < arr.length - 1);
  return lines.slice(-maxLines).join("\n").trim();
}
