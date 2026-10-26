// src/nativeDiff/index.ts — 原生 diff：把 DSH 每轮的文件改动映射到 VS Code 的并排 diff
//
// 思路：DSH 的 Host 进程为每一轮 `workspace/changes` 事件保留了改动摘要和
// 逐文件对比（/api/changes.summary、/api/changes.diff）。扩展已经通过本地代办
// 代理持有 DSH 会话 cookie，因此可以直接请求这两个受鉴权路由，而不用碰 iframe
// 里的页面脚本。拿到 hunk 后，用「当前文件 + 反向打补丁」还原出轮次开始时的内容，
// 再交给 vscode.diff 做原生并排比较。
//
// 选轮次的规则：DSH 的 Web 面板和 Desktop 共用 ~/.dsh/sessions，单看「文件最新」
// 会选到正在流式输出的会话（例如另一个窗口的对话）。这里先按 `workspace/changes`
// 事件的**时间**排序，再优先挑「改动文件落在当前 VS Code 工作区内」的那一轮。
//
// 边界：
// - 摘要只存在于记录该轮的 Host 进程内，历史会话（Host 重启前）没有对比；
// - 二进制、超限、已删除的文件暂不打开；
// - 一次最多打开前 8 个文件。
import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

export interface NativeDiffOptions {
  /** 本地代办代理基地址（已带 DSH 会话 cookie）；未就绪时返回 null */
  getBaseUrl: () => string | null;
  /** 当前工作区根目录 */
  workspaceRoot: () => string | undefined;
  /** 扩展日志出口 */
  log: (line: string) => void;
}

interface ChangedFile {
  path: string;
  display?: string;
}

interface ChangeSummary {
  turn?: number;
  files?: ChangedFile[];
  total?: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface FileDiff {
  hunks?: Hunk[];
  binary?: boolean;
  oversized?: boolean;
  coarse?: boolean;
}

interface ChangeCandidate {
  sessionId: string;
  cwd: string;
  seq: number;
  turn?: number;
  /** `workspace/changes` 事件时间（毫秒） */
  time: number;
}

const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_OPEN_FILES = 8;
const MAX_SCAN_SESSIONS = 40;
const MAX_CANDIDATES = 10;
const MAX_SUMMARY_PROBES = 6;

/** 把「当前内容」按 hunk 反向还原成轮次开始时的内容。 */
export function beforeFromHunks(current: string, hunks: Hunk[]): string {
  if (hunks.length === 0) return current;
  const lines = current.split('\n');
  const ordered = [...hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of ordered) {
    if (!Array.isArray(hunk.lines)) continue;
    const oldLines: string[] = [];
    let newCount = 0;
    for (const raw of hunk.lines) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const prefix = raw[0];
      if (prefix === '\\') continue; // "\ No newline at end of file"
      const body = raw.slice(1);
      if (prefix === '+') {
        newCount += 1;
      } else {
        oldLines.push(body);
        if (prefix === ' ') newCount += 1;
      }
    }
    const start = Math.max(0, hunk.newStart - 1);
    lines.splice(start, newCount, ...oldLines);
  }
  return lines.join('\n');
}

function normalize(p: string): string {
  return path.resolve(p);
}

function sameDirectory(a: string, b: string): boolean {
  const a2 = normalize(a);
  const b2 = normalize(b);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? a2.toLowerCase() === b2.toLowerCase()
    : a2 === b2;
}

function isInside(file: string, root: string): boolean {
  const lower = process.platform === 'darwin' || process.platform === 'win32';
  const f = lower ? normalize(file).toLowerCase() : normalize(file);
  const r = lower ? normalize(root).toLowerCase() : normalize(root);
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function resolvePath(file: string, cwd: string): string {
  return path.isAbsolute(file) ? file : path.join(cwd, file);
}

/**
 * 解压 Session 日志。文件是「多个 zstd 帧首尾相接」的追加式日志：每次落盘追加一帧。
 * Node 24（VS Code 扩展宿主）的 zlib.zstdDecompressSync 只解第一帧，后面的事件全丢，
 * 所以这里按帧魔数切开逐帧解压；单帧文件仍走整包解压。
 */
function decompressSessionLog(raw: Buffer): string {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets: number[] = [];
  let at = raw.indexOf(MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = raw.indexOf(MAGIC, at + MAGIC.length);
  }
  if (offsets.length <= 1) {
    try {
      return zlib.zstdDecompressSync(raw).toString('utf8');
    } catch {
      return '';
    }
  }
  let text = '';
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index] ?? 0;
    const end = index + 1 < offsets.length ? (offsets[index + 1] ?? raw.length) : raw.length;
    try {
      text += zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8');
    } catch {
      // 误把压缩数据里的魔数当帧边界时，该段解压失败：跳过，不拖垮整份日志
    }
  }
  return text;
}

async function readSessionEvents(file: string): Promise<string[] | null> {
  try {
    const raw = await fsp.readFile(file);
    const text = decompressSessionLog(raw);
    return text === '' ? [] : text.split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

/** 扫描近期 Session 日志，列出最近的 `workspace/changes` 轮次（按事件时间倒序）。 */
async function findChangeCandidates(workspaceRoot: string, log: (line: string) => void): Promise<ChangeCandidate[]> {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const sessionsRoot = path.join(home, 'sessions');
  let roots: string[];
  try {
    roots = await fsp.readdir(sessionsRoot);
  } catch {
    return [];
  }
  const files: { file: string; mtime: number }[] = [];
  for (const root of roots) {
    const dir = path.join(sessionsRoot, root);
    let sessions: string[];
    try {
      sessions = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = path.join(dir, session, SESSION_FILE);
      try {
        const stat = await fsp.stat(file);
        files.push({ file, mtime: stat.mtimeMs });
      } catch {
        // 没有日志的目录（已归档/空会话）跳过
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const candidates: ChangeCandidate[] = [];
  for (const { file } of files.slice(0, MAX_SCAN_SESSIONS)) {
    const lines = await readSessionEvents(file);
    if (lines === null || lines.length === 0) continue;
    let header: { type?: string; id?: string; cwd?: string } | null = null;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      continue;
    }
    if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') continue;
    let latest: { seq: number; turn?: number; time: number } | null = null;
    for (const line of lines) {
      if (!line.includes('"workspace/changes"')) continue;
      try {
        const event = JSON.parse(line) as { type?: string; seq?: number; time?: number; data?: { turn?: number } };
        if (event.type === 'workspace/changes' && typeof event.seq === 'number' && typeof event.time === 'number') {
          latest = { seq: event.seq, turn: event.data?.turn, time: event.time };
        }
      } catch {
        // 单行损坏不影响其余事件
      }
    }
    if (latest === null) continue;
    candidates.push({
      sessionId: header.id,
      cwd: header.cwd,
      seq: latest.seq,
      turn: latest.turn,
      time: latest.time,
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  candidates.sort((a, b) => b.time - a.time);
  // cwd 正好等于 VS Code 工作区的候选优先（面板里选过别的 DSH Workspace 时仍有回退）
  const exact = candidates.find((candidate) => sameDirectory(candidate.cwd, workspaceRoot));
  if (exact !== undefined) {
    log(`[diff] 优先命中本工作区会话 ${exact.sessionId} seq=${exact.seq}`);
    return [exact, ...candidates.filter((candidate) => candidate !== exact)];
  }
  return candidates;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** 注册原生 diff 命令、内容提供器和状态栏入口。 */
export function registerNativeDiff(options: NativeDiffOptions): vscode.Disposable[] {
  const contents = new Map<string, string>();

  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const id = uri.path.split('/')[2] ?? '';
      return contents.get(id) ?? '';
    },
  };

  async function openDiff(file: string, display: string, before: string): Promise<void> {
    const id = randomUUID();
    contents.set(id, before);
    const name = path.basename(file);
    const left = vscode.Uri.from({ scheme: 'dsh-diff', path: `/before/${id}/${name}` });
    const right = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${display}（本轮改动）`);
  }

  async function openLatest(): Promise<void> {
    const base = options.getBaseUrl();
    if (base === null) {
      void vscode.window.showWarningMessage('DSH 面板尚未就绪：先打开一次 DSH 面板，等状态变成「运行中」再试。');
      return;
    }
    // 代理的 baseUrl 自带结尾斜杠；拼接口时去掉，否则会变成 //api/... 被 DSH 路由 404。
    const origin = base.replace(/\/+$/, '');
    const root = options.workspaceRoot();
    if (root === undefined) {
      void vscode.window.showWarningMessage('请先打开一个文件夹：DSH 改动按工作区记录。');
      return;
    }
    const candidates = await findChangeCandidates(root, options.log);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('还没有可对比的改动（DSH 只保留当前 Host 进程内记录的轮次）。');
      return;
    }
    // 依次探测摘要，优先取「改动文件落在当前工作区」的那一轮；都不命中则用最新一轮。
    let chosen: ChangeCandidate | null = null;
    let summary: ChangeSummary | null = null;
    for (const candidate of candidates.slice(0, MAX_SUMMARY_PROBES)) {
      const query = `sessionId=${encodeURIComponent(candidate.sessionId)}&seq=${candidate.seq}`;
      let probe: ChangeSummary;
      try {
        probe = (await getJson(`${origin}/api/changes.summary?${query}`)) as ChangeSummary;
      } catch (error) {
        options.log(`[diff] 摘要探测失败 ${candidate.sessionId} seq=${candidate.seq}: ${String(error)}`);
        continue;
      }
      const files = Array.isArray(probe.files) ? probe.files : [];
      const inside = files.some((file) => isInside(resolvePath(file.path, candidate.cwd), root));
      options.log(
        `[diff] 候选 session=${candidate.sessionId} seq=${candidate.seq} turn=${candidate.turn ?? '?'} 文件=${files.length} 命中工作区=${inside}`,
      );
      if (chosen === null) {
        chosen = candidate;
        summary = probe;
      }
      if (inside) {
        chosen = candidate;
        summary = probe;
        break;
      }
    }
    if (chosen === null || summary === null) {
      void vscode.window.showInformationMessage('取不到改动摘要（对应的 DSH 会话可能已经释放）。');
      return;
    }
    const files = Array.isArray(summary.files) ? summary.files : [];
    if (files.length === 0) {
      void vscode.window.showInformationMessage('上一轮没有文件改动。');
      return;
    }
    const query = `sessionId=${encodeURIComponent(chosen.sessionId)}&seq=${chosen.seq}`;
    let opened = 0;
    let skipped = 0;
    const limit = Math.min(files.length, MAX_OPEN_FILES);
    for (let index = 0; index < limit; index += 1) {
      const entry = files[index];
      if (entry === undefined || typeof entry.path !== 'string') continue;
      const absolute = resolvePath(entry.path, chosen.cwd);
      const after = await readText(absolute);
      if (after === null) {
        skipped += 1;
        options.log(`[diff] 跳过不存在的文件 ${absolute}`);
        continue;
      }
      let diff: FileDiff;
      try {
        diff = (await getJson(`${origin}/api/changes.diff?${query}&index=${index}`)) as FileDiff;
      } catch (error) {
        skipped += 1;
        options.log(`[diff] 取对比失败 ${entry.path}: ${String(error)}`);
        continue;
      }
      if (diff.binary === true || diff.oversized === true) {
        skipped += 1;
        options.log(`[diff] 跳过二进制/超限文件 ${entry.path}`);
        continue;
      }
      const before = beforeFromHunks(after, Array.isArray(diff.hunks) ? diff.hunks : []);
      await openDiff(absolute, entry.display ?? entry.path, before);
      opened += 1;
    }
    if (opened === 0) {
      void vscode.window.showInformationMessage(`本轮 ${files.length} 个改动文件都无法生成 diff（跳过 ${skipped} 个）。`);
    } else if (files.length > limit) {
      void vscode.window.showInformationMessage(`已打开前 ${opened} 个文件的 diff（本轮共 ${files.length} 个）。`);
    }
  }

  const command = vscode.commands.registerCommand('dsh.nativeDiff.openLatest', () => {
    void openLatest().catch((error: unknown) => {
      options.log(`[diff] 打开改动失败: ${String(error)}`);
      void vscode.window.showErrorMessage(`打开 DSH 改动 diff 失败：${String(error)}`);
    });
  });

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.text = '$(diff) DSH 改动';
  bar.tooltip = '在 VS Code 中打开 DSH 最近一轮改动的原生并排 diff';
  bar.command = 'dsh.nativeDiff.openLatest';
  bar.show();

  return [vscode.workspace.registerTextDocumentContentProvider('dsh-diff', provider), command, bar];
}
