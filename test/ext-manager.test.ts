import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtManager,
  migrateInheritedPiConfig,
  resolveUninstallSource,
  sourceName,
  type ConfiguredExt,
  type ExtPackageManager,
} from "../src/ext-manager";

const dirs: string[] = [];
function mkd(): string {
  const d = mkdtempSync(join(tmpdir(), "genpi-extmgr-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("sourceName 推导", () => {
  it("① npm 源：npm:foo@1.2 / npm:@scope/name → foo / name", () => {
    expect(sourceName("npm:pi-web-access")).toBe("pi-web-access");
    expect(sourceName("npm:@juicesharp/rpiv-todo@2.1.0")).toBe("rpiv-todo");
    expect(sourceName("npm:@narumitw/pi-plan-mode")).toBe("pi-plan-mode");
  });
  it("② git/本地源取末段并去 .git", () => {
    expect(sourceName("git+https://github.com/u/pi-subagents.git")).toBe("pi-subagents");
    expect(sourceName("/abs/path/my-ext/")).toBe("my-ext");
  });
});

describe("卸载按名解析", () => {
  const pkgs: ConfiguredExt[] = [
    { source: "npm:pi-web-access" },
    { source: "npm:@juicesharp/rpiv-todo", installedPath: "/x" },
  ];
  it("③ 名称/原始 source 均可命中", () => {
    expect(resolveUninstallSource(pkgs, "rpiv-todo")).toBe("npm:@juicesharp/rpiv-todo");
    expect(resolveUninstallSource(pkgs, "npm:pi-web-access")).toBe("npm:pi-web-access");
    expect(resolveUninstallSource(pkgs, "不存在")).toBeUndefined();
  });
  it("④ uninstall 走 removeAndPersist（收到原始 source）；未命中返回 false", async () => {
    const removed: string[] = [];
    const pm: ExtPackageManager = {
      installAndPersist: async (s) => void s,
      removeAndPersist: async (s) => {
        removed.push(s);
        return true;
      },
      listConfiguredPackages: () => pkgs,
    };
    const mgr = createExtManager(pm);
    expect(await mgr.uninstall("pi-web-access")).toBe(true);
    expect(removed).toEqual(["npm:pi-web-access"]);
    expect(await mgr.uninstall("nope")).toBe(false);
  });
});

describe("pi 扩展继承迁移（契约 17 v1.2：初始零扩展）", () => {
  function fixture(): string {
    const agentDir = join(mkd(), "genpi-root");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultModel: "keep-me",
        packages: ["npm:pi-web-access", "npm:pi-subagents", "git+https://github.com/u/pi-subagents.git"],
        extensions: ["-builtin:mcp", "/abs/path/copied-ext.ts"],
      }),
    );
    mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
    mkdirSync(join(agentDir, "pi-subagents")); // git 源安装目录
    mkdirSync(join(agentDir, "pi-web-access")); // npm 包运行时留下的数据目录
    return agentDir;
  }
  it("⑤ 剥离 packages/可装载 extensions、保留 -builtin: 禁用指令与其余键，备份 settings 与已装目录", () => {
    const agentDir = fixture();
    const m = migrateInheritedPiConfig(agentDir, () => new Date("2026-10-31T10:00:00Z"));
    expect(m).not.toBeNull();
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    expect(settings.packages).toBeUndefined();
    expect(settings.extensions).toEqual(["-builtin:mcp"]); // 禁用指令是用户偏好，保留
    expect(settings.defaultModel).toBe("keep-me");
    const backup = m!.backupDir;
    expect(existsSync(join(backup, "settings.json"))).toBe(true);
    expect(existsSync(join(backup, "npm"))).toBe(true); // npm 源整体移入备份
    expect(existsSync(join(backup, "pi-subagents"))).toBe(true); // git 源根级目录
    expect(existsSync(join(backup, "pi-web-access"))).toBe(true); // npm 包同名数据目录同样移入
    expect(existsSync(join(agentDir, "npm"))).toBe(false);
    expect(existsSync(join(agentDir, "pi-web-access"))).toBe(false);
  });
  it("⑥ 幂等：已迁移（备份标记存在）不再剥离——genpi ext 之后写入的配置受保护", () => {
    const agentDir = fixture();
    expect(migrateInheritedPiConfig(agentDir)).not.toBeNull();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:my-ext"] }));
    expect(migrateInheritedPiConfig(agentDir)).toBeNull();
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    expect(settings.packages).toEqual(["npm:my-ext"]);
  });
  it("⑦ 干净配置不触发迁移；仅含 -builtin: 的 extensions 不算继承；settings 缺失/损坏返回 null", () => {
    const clean = join(mkd(), "clean");
    mkdirSync(clean, { recursive: true });
    writeFileSync(join(clean, "settings.json"), JSON.stringify({ defaultModel: "x" }));
    expect(migrateInheritedPiConfig(clean)).toBeNull();
    const builtinOnly = join(mkd(), "bo");
    mkdirSync(builtinOnly, { recursive: true });
    writeFileSync(join(builtinOnly, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    expect(migrateInheritedPiConfig(builtinOnly)).toBeNull(); // 无可装载继承，不动
    const broken = join(mkd(), "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "settings.json"), "{not json");
    expect(migrateInheritedPiConfig(broken)).toBeNull();
    expect(migrateInheritedPiConfig(join(mkd(), "missing"))).toBeNull();
  });
});
