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
