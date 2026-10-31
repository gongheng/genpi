// genpi 扩展管理：初始零扩展（不继承 pi 的扩展配置），安装/卸载复用 pi 的 PackageManager。
// 契约 17（v1.2）：MUST NOT 继承 `~/.pi`（或复制 settings.json 带来）的 packages/extensions；
// 扩展仅经 `genpi ext install` 显式安装于 `~/.genpi`，可用 `genpi ext uninstall` 移除。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** pi PackageManager 的结构子集（DefaultPackageManager 天然满足，测试可注入 fake）。 */
export interface ExtPackageManager {
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string): Promise<boolean>;
  listConfiguredPackages(): { source: string; scope?: string; installedPath?: string }[];
}

export interface ConfiguredExt {
  source: string;
  scope?: string;
  installedPath?: string;
}

export interface ExtManager {
  install(source: string): Promise<void>;
  uninstall(nameOrSource: string): Promise<boolean>;
  list(): ConfiguredExt[];
}

/** 从包 source 推导展示名：npm:foo@1 / npm:@scope/name → foo / name；git URL/路径 → 末段（去 .git）。 */
export function sourceName(source: string): string {
  const npm = /^npm:(.+)$/.exec(source.trim());
  if (npm) {
    const pkg = npm[1];
    const atName = /^(?:@[^/]+\/)?([^/@]+)/.exec(pkg);
    return atName?.[1] ?? pkg;
  }
  const clean = source.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const seg = clean.split(/[\\/#]/).filter(Boolean).pop() ?? clean;
  return seg;
}

/** 按名字或原始 source 找到已配置扩展的 source（卸载需要原始 source）。 */
export function resolveUninstallSource(pkgs: ConfiguredExt[], nameOrSource: string): string | undefined {
  const key = nameOrSource.trim();
  const exact = pkgs.find((p) => p.source === key);
  if (exact) return exact.source;
  return pkgs.find((p) => sourceName(p.source) === key)?.source;
}

export function createExtManager(pm: ExtPackageManager): ExtManager {
  return {
    install: (source) => pm.installAndPersist(source),
    uninstall: async (nameOrSource) => {
      const source = resolveUninstallSource(pm.listConfiguredPackages(), nameOrSource);
      return source ? pm.removeAndPersist(source) : false;
    },
    list: () => pm.listConfiguredPackages(),
  };
}

// ---------- 一次性迁移：剥离复制自 pi 的扩展继承 ----------

export interface PiInheritanceMigration {
  backupDir: string;
  strippedKeys: string[];
  inheritedPackages: string[];
  inheritedExtensions: string[];
  movedDirs: string[];
}

const BACKUP_ROOT = ".pi-inheritance-backup";

/**
 * 剥离 `~/.genpi/settings.json` 中继承自 pi 的 `packages`/`extensions` 键，并把已安装目录移入备份。
 * 一次性：备份标记目录存在即跳过（此后 `genpi ext install` 写入的配置不受影响）。幂等、可回滚（备份在案）。
 */
export function migrateInheritedPiConfig(agentDir: string, now: () => Date = () => new Date()): PiInheritanceMigration | null {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return null;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return null; // 解析失败不动用户文件
  }
  const pkgs = Array.isArray(settings.packages) ? (settings.packages as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const exts = Array.isArray(settings.extensions) ? (settings.extensions as unknown[]).filter((e): e is string => typeof e === "string") : [];
  const loadableExts = exts.filter((e) => !e.startsWith("-builtin:")); // 禁用指令是用户偏好非扩展装载，保留
  if (pkgs.length === 0 && loadableExts.length === 0) return null;
  const backupRoot = join(agentDir, BACKUP_ROOT);
  if (existsSync(backupRoot)) return null; // 已迁移过：尊重 genpi ext 之后的写入

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });
  const movedDirs: string[] = [];
  const moveIn = (from: string, to: string): void => {
    if (!existsSync(from)) return;
    try {
      renameSync(from, to);
      movedDirs.push(from);
    } catch {
      /* 移动失败不阻塞：剥离配置后这些目录不再被装载 */
    }
  };

  // 每个继承包名都移根级同名目录（git/本地源装在此；npm 包运行时也会留数据目录）
  for (const source of pkgs) {
    const name = sourceName(source);
    moveIn(join(agentDir, name), join(backupDir, name));
  }
  // npm 源统一移整个 npm 目录（node_modules 依赖共享，逐个移会破坏）
  if (pkgs.some((p) => p.startsWith("npm:"))) {
    moveIn(join(agentDir, "npm"), join(backupDir, "npm"));
  }

  copyFileSync(settingsPath, join(backupDir, "settings.json"));
  delete settings.packages;
  if (exts.some((e) => e.startsWith("-builtin:"))) {
    // 保留禁用指令，仅剥可装载条目（可能剥后为空数组，也保留键以明示用户偏好）
    settings.extensions = exts.filter((e) => e.startsWith("-builtin:"));
  } else {
    delete settings.extensions;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    backupDir,
    strippedKeys: [...(pkgs.length ? ["packages"] : []), ...(loadableExts.length ? ["extensions"] : [])],
    inheritedPackages: pkgs,
    inheritedExtensions: loadableExts,
    movedDirs,
  };
}

/** 迁移结果的人读摘要（无迁移返回 null）。 */
export function describeMigration(m: PiInheritanceMigration): string {
  const names = m.inheritedPackages.map(sourceName);
  return [
    "genpi 不继承 pi 的扩展：已剥离复制来的扩展配置" +
      (names.length ? `（${names.join("、")}）` : "") +
      "，并把已装目录移入备份。",
    `备份：${m.backupDir}（需要时可用 genpi ext install <source> 显式重装）`,
  ].join("\n");
}
