/**
 * git-commit —— 生成简要 commit 信息并提交 git
 *
 * 命令（TUI）：
 *   /commit            预览变更 → editor 编辑/确认建议信息 → 提交
 *   /commit -y         跳过编辑，直接提交自动生成的简要信息
 *   /commit 自定义信息 使用自定义信息提交（不生成）
 *
 * 工具（供 LLM 调用）：
 *   git_commit         message 可选（缺省自动生成）；skipConfirm 控制是否弹确认
 *
 * 信息生成规则（启发式）：
 *   标题：动词(新增/删除/重命名/更新) + 变更类别(脚本/文档/缓存/Excel表…) + 文件数
 *   正文：每个变更文件一行（状态字母 + 路径），如 "- [M] scripts/_update_summary.py"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Change {
  path: string;
  status: string; // porcelain 状态（trim后）: M/A/D/R/??/U...
}

export type { Change }

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// ── 类别规则（按顺序匹配，取第一个命中）──────────────────────────
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/^scripts\/.+\.py$/, "脚本"],
  [/^update\.py$/, "更新工具"],
  [/\.md$/, "文档"],
  [/\.xlsx$/, "Excel表"],
  [/^cache\//, "缓存数据"],
  [/\.py$/, "脚本"],
  [/\.json$/, "数据"],
];

export function categorize(path: string): string {
  for (const [re, name] of CATEGORY_RULES) {
    if (re.test(path)) return name;
  }
  return "文件";
}

export function verbFor(status: string): string {
  const s = status[0];
  if (s === "D") return "删除";
  if (s === "R") return "重命名";
  return "更新"; // A/M/C/U/?? → 更新（全新增场景在 buildMessage 中替换为"新增"）
}

// ── porcelain 解析 ─────────────────────────────────────────────
export function parsePorcelain(text: string): Change[] {
  const out: Change[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim() || "?"; // "M" | "??" | "A" | "D" | "R" ...
    let path = line.slice(3).trim();
    if (path.startsWith('"')) {
      try {
        path = JSON.parse(path) as string; // git 对含特殊字符路径加引号转义
      } catch {
        /* 保留原样 */
      }
    }
    if ((status === "R" || status === "C") && path.includes(" -> ")) {
      path = path.split(" -> ")[1].trim();
    }
    out.push({ path, status });
  }
  return out;
}

// ── 信息生成 ───────────────────────────────────────────────────
export function buildTitle(changes: Change[]): string {
  const n = changes.length;
  const verbs = new Set(changes.map((c) => verbFor(c.status)));
  const verb = verbs.size === 1 ? [...verbs][0]! : "更新";
  if (n === 1) {
    const c = changes[0];
    return `${verb} ${c.path}`;
  }
  const groups = new Map<string, number>();
  for (const c of changes) {
    const g = categorize(c.path);
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  let scope: string;
  if (sorted.length === 1) scope = sorted[0][0];
  else if (sorted.length === 2) scope = sorted.map(([g]) => g).join("与");
  else scope = sorted.slice(0, 2).map(([g]) => g).join("与") + "等";
  return `${verb}${scope}（${n} 个文件）`;
}

export function buildMessage(changes: Change[]): string {
  const body = changes.map((c) => `- [${c.status}] ${c.path}`).join("\n");
  return `${buildTitle(changes)}\n\n${body}`;
}

function fileList(changes: Change[]): string {
  return changes.map((c) => `- [${c.status}] ${c.path}`).join("\n");
}

// ── git 执行封装 ───────────────────────────────────────────────
function makeExec(cwd: string, pi: ExtensionAPI, signal?: AbortSignal) {
  return async (args: string[]): Promise<ExecResult> => {
    const r = await pi.exec("git", ["-C", cwd, ...args], { signal });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? -1 };
  };
}

async function collectChanges(
  exec: (args: string[]) => Promise<ExecResult>,
): Promise<{ ok: boolean; reason?: string; changes?: Change[] }> {
  const repo = await exec(["rev-parse", "--is-inside-work-tree"]);
  if (repo.code !== 0) return { ok: false, reason: "当前目录不是 git 仓库" };
  const st = await exec(["status", "--porcelain", "-uall"]);
  if (st.code !== 0) return { ok: false, reason: `git status 失败: ${st.stderr.trim().slice(0, 120)}` };
  const changes = parsePorcelain(st.stdout);
  if (changes.length === 0) return { ok: false, reason: "没有待提交的变更" };
  return { ok: true, changes };
}

async function checkIdentity(exec: (args: string[]) => Promise<ExecResult>): Promise<string | null> {
  for (const key of ["user.name", "user.email"]) {
    const r = await exec(["config", key]);
    if (r.code !== 0 || !r.stdout.trim()) return key;
  }
  return null;
}

async function doCommit(
  exec: (args: string[]) => Promise<ExecResult>,
  message: string,
): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const add = await exec(["add", "-A"]);
  if (add.code !== 0) return { ok: false, error: `git add 失败: ${add.stderr.trim().slice(0, 200)}` };
  const lines = message.trim().split("\n");
  const title = lines[0].trim();
  const body = lines.slice(1).join("\n").trim();
  const args = ["commit", "-m", title];
  if (body) args.push("-m", body);
  const cm = await exec(args);
  if (cm.code !== 0) return { ok: false, error: `git commit 失败: ${cm.stderr.trim().slice(0, 200)}` };
  const h = await exec(["rev-parse", "--short", "HEAD"]);
  return { ok: true, hash: h.stdout.trim() };
}

// ── 扩展入口 ───────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // 命令：/commit
  pi.registerCommand("commit", {
    description: "生成简要 commit 信息并提交（/commit -y 免确认；/commit 自定义信息）",
    handler: async (args, ctx) => {
      const exec = makeExec(ctx.cwd, pi);
      const coll = await collectChanges(exec);
      if (!coll.ok) {
        ctx.ui.notify(coll.reason!, "info");
        return;
      }
      const changes = coll.changes!;
      const arg = (args ?? "").trim();
      let skipConfirm = false;
      let custom: string | undefined;
      if (arg === "-y" || arg === "--yes" || arg === "-f") skipConfirm = true;
      else if (arg) custom = arg;

      let message: string;
      if (custom) {
        message = custom;
      } else {
        message = buildMessage(changes);
        if (!skipConfirm && ctx.hasUI) {
          const edited = await ctx.ui.editor("commit 信息（第一行为标题，可编辑；Esc 取消）", message);
          if (edited === undefined) {
            ctx.ui.notify("已取消提交", "info");
            return;
          }
          message = edited.trim();
        }
      }
      if (!message) {
        ctx.ui.notify("commit 信息为空，已取消", "error");
        return;
      }

      const identity = await checkIdentity(exec);
      if (identity) {
        ctx.ui.notify(
          `未配置 git ${identity}，请先执行: git config --global ${identity} \"你的名字/邮箱\"`,
          "error",
        );
        return;
      }

      const res = await doCommit(exec, message);
      if (!res.ok) {
        ctx.ui.notify(res.error!, "error");
        return;
      }
      const firstLine = message.split("\n")[0].trim();
      ctx.ui.notify(`已提交 ${res.hash}: ${firstLine}`, "info");
    },
  });

  // 工具：git_commit
  pi.registerTool({
    name: "git_commit",
    label: "提交Git变更",
    description:
      "根据工作区变更自动生成简要中文 commit 信息并提交 git。" +
      "message 缺省时自动生成（形如「更新脚本与文档（8 个文件）」，正文含文件清单）；" +
      "用户已明确要求直接提交时传 skipConfirm=true，否则默认弹确认框等待用户确认。",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "自定义 commit 信息（可选，缺省自动生成）" })),
      skipConfirm: Type.Optional(Type.Boolean({ description: "true 跳过用户确认直接提交" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exec = makeExec(ctx.cwd, pi, signal);
      const coll = await collectChanges(exec);
      if (!coll.ok) {
        return { content: [{ type: "text", text: coll.reason! }], details: {} };
      }
      const changes = coll.changes!;
      const custom = (params.message ?? "").trim();
      const message = custom || buildMessage(changes);

      if (!params.skipConfirm && ctx.hasUI) {
        const ok = await ctx.ui.confirm("提交Git变更", `${message}\n\n${fileList(changes)}\n\n确认提交？`);
        if (!ok) {
          return { content: [{ type: "text", text: "已取消提交" }], details: { cancelled: true } };
        }
      }
      if (!message.trim()) {
        return { content: [{ type: "text", text: "commit 信息为空，已取消" }], details: { cancelled: true } };
      }

      const identity = await checkIdentity(exec);
      if (identity) {
        return {
          content: [{ type: "text", text: `未配置 git ${identity}，请先执行: git config --global ${identity} "名字/邮箱"` }],
          details: { error: "missing git identity" },
        };
      }

      const res = await doCommit(exec, message);
      if (!res.ok) {
        return { content: [{ type: "text", text: res.error! }], details: { error: true } };
      }
      const firstLine = message.split("\n")[0].trim();
      return {
        content: [{ type: "text", text: `已提交 ${res.hash}: ${firstLine}\n\n${fileList(changes)}` }],
        details: { hash: res.hash, message: firstLine, files: changes },
      };
    },
  });
}
