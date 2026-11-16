// tasks.md 勾选解析（IMPLEMENT 逐任务循环用，设计 §2.2）
export interface ParsedTask {
  /** 原始行（用于回写定位） */
  line: string;
  /** 任务描述（去掉列表标记与勾选框） */
  text: string;
}

const UNCHECKED = /^(\s*[-*]\s+)\[ \]\s*(.+)$/;

/** 提取未勾选任务（保持文件顺序）。 */
export function parseUnchecked(tasksMd: string): ParsedTask[] {
  return tasksMd
    .split("\n")
    .flatMap((line) => {
      const m = UNCHECKED.exec(line);
      return m ? [{ line, text: m[2].trim() }] : [];
    });
}

/** 把首个匹配的未勾选行勾上（按原始行精确定位）。 */
export function tick(tasksMd: string, taskLine: string): string {
  const idx = tasksMd.split("\n").indexOf(taskLine);
  if (idx < 0) return tasksMd;
  const lines = tasksMd.split("\n");
  lines[idx] = lines[idx].replace(/\[ \]/, "[x]");
  return lines.join("\n");
}

/**
 * 提取固定验收命令（T38/A1②）：扫全（含已勾选任务——验证是全量回归）「验收/验收命令」行的命令。
 * 优先反引号包裹段（可多段）；无反引号则取冒号后到（/。/，/期望前的整段。去重保序。
 */
export function extractAcceptanceCommands(tasksMd: string): string[] {
  const out: string[] = [];
  for (const raw of tasksMd.split("\n")) {
    if (!/验收(?:命令)?[:：]/.test(raw)) continue;
    const ticks = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const cmds = ticks.length
      ? ticks
      : [raw.replace(/^[^:：]*[:：]/, "").replace(/（[^）]*）/g, "").replace(/[,，。;；].*$/, "").trim()].filter(Boolean);
    for (const c of cmds) if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
