// genpi 入口：数据根独立 → 配置 → pi 扩展继承清理 → 凭证检查 → TUI；install/uninstall/list/update 顶层命令（对齐 pi 习惯）/--resume/--demo-run/--selftest
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyDataRoot, hasCredentials, resolveConfig } from "../src/config";
import { VERSION, runDemoMode, runTui } from "../src/tui/app";
import { createExtManager, describeMigration, migrateInheritedPiConfig, resolveUninstallSource, sourceName } from "../src/ext-manager";

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version")) {
    console.log("genpi " + VERSION);
    return 0;
  }
  if (argv.includes("--demo-run")) {
    return runDemoMode();
  }
  if (argv.includes("--selftest")) {
    return selftest();
  }
  const projectRoot = process.cwd();
  const agentDir = applyDataRoot(homedir());
  // 扩展管理子命令：不依赖模型凭证（安装只需 npm/git 网络）
  // 扩展管理顶层命令（对齐 pi 习惯：pi install …→ genpi install …）；genpi ext … 保留为兼容别名
  const EXT_COMMANDS = new Set(["install", "uninstall", "remove", "update", "list"]);
  const extArgs = argv[0] === "ext" ? argv.slice(1) : EXT_COMMANDS.has(argv[0] ?? "") ? argv : null;
  if (extArgs) {
    const migrated = migrateInheritedPiConfig(agentDir);
    if (migrated) console.log(describeMigration(migrated));
    return extCli(extArgs, { projectRoot, agentDir });
  }
  if (!hasCredentials(agentDir)) {
    console.log("genpi 首次使用：数据根在 " + agentDir);
    console.log("请先配置模型凭证（把 pi 的 auth.json/settings.json 放入上述目录，或运行 pi 并复制其 ~/.pi/agent 配置）。")
    console.log("详见 README「首次配置」。");
    return 1;
  }
  // 一次性清理：genpi 初始零扩展，不继承复制来的 pi packages/extensions（契约 17 v1.2）
  const migrated = migrateInheritedPiConfig(agentDir);
  if (migrated) console.log(describeMigration(migrated));
  const hasGit = existsSync(join(projectRoot, ".git"));

  const resumeIdx = argv.indexOf("--resume");
  const resumeRunId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
  return runTui({ projectRoot, home: homedir(), hasGit, resumeRunId });
}

// ---------- genpi install/uninstall/list/update：安装/卸载/列表/更新（复用 pi PackageManager，装于 ~/.genpi） ----------

async function extCli(argv: string[], ctx: { projectRoot: string; agentDir: string }): Promise<number> {
  const [cmd, ...rest] = argv;
  const usage = [
    "用法（与 pi 一致）：",
    "  genpi install <source>       安装扩展（npm:包名 / git URL / 本地路径）",
    "  genpi uninstall <名称>       卸载扩展（别名 remove；可用名称或原始 source）",
    "  genpi list                   列出已安装扩展",
    "  genpi update [名称]          更新扩展（缺省全部）",
  ].join("\n");
  if (!cmd) {
    console.log(usage);
    return 0;
  }
  const pi = await import("@earendil-works/pi-coding-agent");
  const settingsManager = pi.SettingsManager.create(ctx.projectRoot, ctx.agentDir);
  const pm = new pi.DefaultPackageManager({ cwd: ctx.projectRoot, agentDir: ctx.agentDir, settingsManager });
  const mgr = createExtManager(pm);
  try {
    if (cmd === "install") {
      if (!rest[0]) {
        console.log("用法：genpi install <source>（npm:包名 / git URL / 本地路径）");
        return 1;
      }
      await mgr.install(rest[0]);
      console.log(`✔ 已安装 ${rest[0]}（仅对 genpi 生效，装于 ${ctx.agentDir}）`);
      return 0;
    }
    if (cmd === "uninstall" || cmd === "remove") {
      if (!rest[0]) {
        console.log("用法：genpi uninstall <名称>（可用名称或原始 source；别名 remove）");
        return 1;
      }
      const ok = await mgr.uninstall(rest[0]);
      if (!ok) {
        console.log(`未找到扩展「${rest[0]}」，用 genpi list 查看已安装。`);
        return 1;
      }
      console.log(`✔ 已卸载 ${rest[0]}`);
      return 0;
    }
    if (cmd === "list") {
      const list = mgr.list();
      if (list.length === 0) {
        console.log("尚未安装任何扩展（genpi 初始零扩展，不继承 pi 的）。用 genpi install <source> 安装。");
        return 0;
      }
      for (const e of list) console.log(`${""}- ${e.source}${e.installedPath ? `  →  ${e.installedPath}` : ""}`);
      return 0;
    }
    if (cmd === "update") {
      const source = rest[0] ? resolveUninstallSource(mgr.list(), rest[0]) ?? sourceName(rest[0]) : undefined;
      await pm.update(source);
      console.log(source ? `✔ 已更新 ${source}` : "✔ 已更新全部扩展");
      return 0;
    }
    console.log(`未知子命令：${cmd}\n\n${usage}`);
    return 1;
  } catch (e) {
    console.error(`✗ ${String(e)}`);
    return 1;
  }
}

async function selftest(): Promise<number> {
  const checks: { name: string; ok: boolean }[] = [];
  const home = homedir();
  const agentDir = applyDataRoot(home);
  checks.push({ name: "数据根可写 (" + agentDir + ")", ok: (() => {
    try {
      mkdirSync(agentDir, { recursive: true });
      rmSync(join(agentDir, ".selftest-probe"), { force: true });
      return existsSync(agentDir);
    } catch {
      return false;
    }
  })() });
  checks.push({ name: "配置解析", ok: resolveConfig(process.cwd(), agentDir).budget > 0 });
  const { createResourceProvider } = await import("./resources");
  checks.push({ name: "方法论资源装载", ok: createResourceProvider().preamble().length > 0 });
  try {
    await import("@earendil-works/pi-coding-agent");
    checks.push({ name: "pi SDK 可 import", ok: true });
  } catch {
    checks.push({ name: "pi SDK 可 import", ok: false });
  }
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}`);
    if (!c.ok) failed++;
  }
  return failed === 0 ? 0 : 1;
}
