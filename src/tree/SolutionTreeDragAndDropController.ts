import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PendingStore } from '../pendingStore';
import { SolutionTreeItem } from './treeNodes';

const TREE_MIME = 'application/vnd.code.tree.unitysolutionexplorerview';

/** 仅可 JSON 序列化的拖拽载荷（避免 SolutionTreeItem.parent 循环引用导致树内放下失败） */
export interface TreeDragPayload {
  type: 'file' | 'folder';
  fullPath: string;
  projectCsprojPath: string;
}

function pathKey(p: string): string {
  try {
    const resolved = path.resolve(p);
    const n = path.normalize(resolved);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  } catch {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  }
}

/** 若某文件夹也在选中集合中，则忽略其下被选中的项，避免重复移动（不依赖 parent 引用） */
function getLocalRootsByPath(sources: TreeDragPayload[]): TreeDragPayload[] {
  return sources.filter((a) => {
    if (a.type !== 'file' && a.type !== 'folder') return false;
    const ka = pathKey(a.fullPath);
    for (const b of sources) {
      if (a === b || b.type !== 'folder') continue;
      const kb = pathKey(b.fullPath);
      if (ka === kb) continue;
      if (ka.startsWith(kb + path.sep)) return false;
    }
    return true;
  });
}

function parseTreeDragPayloads(internal: vscode.DataTransferItem | undefined): TreeDragPayload[] | undefined {
  if (!internal?.value) return undefined;
  const v = internal.value;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as unknown;
      return normalizePayloadArray(parsed);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) {
    return normalizePayloadArray(v);
  }
  return undefined;
}

function normalizePayloadArray(raw: unknown): TreeDragPayload[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TreeDragPayload[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (o.type !== 'file' && o.type !== 'folder') continue;
    if (typeof o.fullPath !== 'string') continue;
    const csproj = typeof o.projectCsprojPath === 'string' ? o.projectCsprojPath : '';
    out.push({ type: o.type, fullPath: o.fullPath, projectCsprojPath: csproj });
  }
  return out.length ? out : undefined;
}

/** 禁止将文件夹移动到其自身或其子路径下 */
function folderWouldBeInsideItself(folderFullPath: string, destParentDir: string): boolean {
  const f = pathKey(folderFullPath);
  const d = pathKey(destParentDir);
  const sep = path.sep;
  return d === f || d.startsWith(f + sep);
}

/** 一次拖拽中待执行的移动（已排除源与目标路径相同的情况） */
interface MovePlanEntry {
  oldPath: string;
  type: 'file' | 'folder';
  label: string;
}

function resolveDropTarget(
  target: SolutionTreeItem | undefined
): { destDir: string; projectCsprojPath: string } | undefined {
  if (!target) return undefined;
  switch (target.type) {
    case 'solution':
      return undefined;
    case 'project': {
      if (!target.fullPath) return undefined;
      const csproj = target.projectCsprojPath ?? target.fullPath;
      return { destDir: path.dirname(target.fullPath), projectCsprojPath: csproj };
    }
    case 'folder': {
      if (!target.projectCsprojPath) return undefined;
      return { destDir: target.fullPath, projectCsprojPath: target.projectCsprojPath };
    }
    case 'file': {
      if (!target.projectCsprojPath) return undefined;
      return { destDir: path.dirname(target.fullPath), projectCsprojPath: target.projectCsprojPath };
    }
    default:
      return undefined;
  }
}

export class SolutionTreeDragAndDropController implements vscode.TreeDragAndDropController<SolutionTreeItem> {
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'] as const;
  /**
   * 不可声明 `text/uri-list`：VS Code 会在 fillEditorsDragData 之后把 ResourceURLs 写成空串，导致无法拖入编辑器。
   * 我们仍在 handleDrag 中写入 text/uri-list / application/vnd.code.uri-list 供 Chat 等读取。
   */
  readonly dragMimeTypes: string[] = [];

  constructor(
    private readonly pendingStore: PendingStore,
    private readonly refreshProject: (csprojPath: string) => void
  ) {}

  /** 移动前模态确认；无实际可移动项时返回 false */
  private async confirmMovesBeforeApply(plan: MovePlanEntry[], destDir: string): Promise<boolean> {
    if (plan.length === 0) return false;
    const destLabel = path.basename(path.normalize(destDir)) || destDir;
    const maxLines = 10;
    const lines = plan.slice(0, maxLines).map((p) => `· ${p.label}${p.type === 'folder' ? '/' : ''}`);
    const suffix =
      plan.length > maxLines
        ? `\n… and ${plan.length} items total`
        : plan.length > 1
          ? `\n${plan.length} items total`
          : '';
    const choice = await vscode.window.showWarningMessage(
      `Move the following into "${destLabel}"?\n\n${lines.join('\n')}${suffix}`,
      { modal: true },
      'Move',
      'Cancel'
    );
    return choice === 'Move';
  }

  handleDrag(source: readonly SolutionTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const payloads: TreeDragPayload[] = [];
    const uris: vscode.Uri[] = [];
    for (const item of source) {
      if (item.type === 'file' || item.type === 'folder') {
        const csproj = item.projectCsprojPath ?? '';
        payloads.push({ type: item.type, fullPath: item.fullPath, projectCsprojPath: csproj });
        uris.push(vscode.Uri.file(item.fullPath));
      }
    }
    const uriListStr = uris.map((u) => u.toString()).join('\r\n');
    if (uriListStr) {
      dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriListStr));
      // 与 VS Code 工作台 DataTransfers.INTERNAL_URI_LIST 一致，改善部分 Web/Chromium 路径下的拖放
      dataTransfer.set('application/vnd.code.uri-list', new vscode.DataTransferItem(uriListStr));
    }
    if (payloads.length > 0) {
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(payloads)));
    }
  }

  async handleDrop(
    target: SolutionTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const resolved = resolveDropTarget(target);
    if (!resolved) {
      vscode.window.showWarningMessage(
        'Drop onto an assembly, folder, or file (dropping on a file moves into its parent folder).'
      );
      return;
    }

    const { destDir, projectCsprojPath } = resolved;
    const projectDir = path.dirname(projectCsprojPath);

    const internalItem = dataTransfer.get(TREE_MIME);
    const parsedPayloads = parseTreeDragPayloads(internalItem);
    if (parsedPayloads?.length) {
      const roots = getLocalRootsByPath(parsedPayloads);
      if (roots.length === 0) return;

      const plan: MovePlanEntry[] = [];
      for (const src of roots) {
        if (!src.projectCsprojPath || src.projectCsprojPath !== projectCsprojPath) {
          vscode.window.showWarningMessage('Cross-assembly drag is not supported. Move within the same .csproj only.');
          return;
        }
        if (src.type === 'folder' && folderWouldBeInsideItself(src.fullPath, destDir)) {
          vscode.window.showErrorMessage('Cannot move a folder into itself or a subfolder.');
          return;
        }
        const newPath = path.join(destDir, path.basename(src.fullPath));
        if (pathKey(src.fullPath) === pathKey(newPath)) continue;
        plan.push({
          oldPath: src.fullPath,
          type: src.type,
          label: path.basename(src.fullPath),
        });
      }

      if (plan.length === 0) return;
      if (!(await this.confirmMovesBeforeApply(plan, destDir))) return;

      let changed = false;
      for (const entry of plan) {
        if (token.isCancellationRequested) return;
        const ok =
          entry.type === 'file'
            ? this.moveFile(entry.oldPath, destDir, projectCsprojPath, projectDir)
            : this.moveFolder(entry.oldPath, destDir, projectCsprojPath, projectDir);
        if (!ok) return;
        changed = true;
      }
      if (changed) this.refreshProject(projectCsprojPath);
      return;
    }

    const uriList = dataTransfer.get('text/uri-list');
    if (uriList?.value) {
      const raw = String(uriList.value);
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const plan: MovePlanEntry[] = [];
      for (const line of lines) {
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(line, true);
        } catch {
          continue;
        }
        if (uri.scheme !== 'file') continue;
        const srcPath = uri.fsPath;
        if (!fs.existsSync(srcPath)) continue;
        const rel = path.relative(projectDir, srcPath);
        if (rel.startsWith('..') || rel === '') {
          vscode.window.showWarningMessage('Only files or folders inside the target assembly directory can be dropped here.');
          return;
        }
        const stat = fs.statSync(srcPath);
        const newPath = path.join(destDir, path.basename(srcPath));
        if (pathKey(srcPath) === pathKey(newPath)) continue;
        if (stat.isDirectory()) {
          if (folderWouldBeInsideItself(srcPath, destDir)) {
            vscode.window.showErrorMessage('Cannot move a folder into itself or a subfolder.');
            return;
          }
          plan.push({
            oldPath: srcPath,
            type: 'folder',
            label: path.basename(srcPath),
          });
        } else if (stat.isFile()) {
          plan.push({
            oldPath: srcPath,
            type: 'file',
            label: path.basename(srcPath),
          });
        }
      }

      if (plan.length === 0) return;
      if (!(await this.confirmMovesBeforeApply(plan, destDir))) return;

      let changed = false;
      for (const entry of plan) {
        if (token.isCancellationRequested) return;
        const ok =
          entry.type === 'file'
            ? this.moveFile(entry.oldPath, destDir, projectCsprojPath, projectDir)
            : this.moveFolder(entry.oldPath, destDir, projectCsprojPath, projectDir);
        if (!ok) return;
        changed = true;
      }
      if (changed) this.refreshProject(projectCsprojPath);
    }
  }

  private moveFile(
    oldPath: string,
    destDir: string,
    projectCsprojPath: string,
    projectDir: string
  ): boolean {
    const newPath = path.join(destDir, path.basename(oldPath));
    if (pathKey(oldPath) === pathKey(newPath)) {
      return true;
    }
    if (fs.existsSync(newPath)) {
      vscode.window.showErrorMessage(`Target already exists: ${path.basename(newPath)}`);
      return false;
    }
    try {
      this.pendingStore.removePath(projectCsprojPath, path.relative(projectDir, oldPath));
      fs.renameSync(oldPath, newPath);
      const relNew = path.relative(projectDir, newPath);
      if (relNew && !relNew.startsWith('..')) {
        this.pendingStore.addFile(projectCsprojPath, relNew);
      }
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('Move failed: ' + (e as Error).message);
      return false;
    }
  }

  private moveFolder(
    oldPath: string,
    destDir: string,
    projectCsprojPath: string,
    projectDir: string
  ): boolean {
    const newPath = path.join(destDir, path.basename(oldPath));
    if (pathKey(oldPath) === pathKey(newPath)) {
      return true;
    }
    if (fs.existsSync(newPath)) {
      vscode.window.showErrorMessage(`Target already exists: ${path.basename(newPath)}`);
      return false;
    }
    try {
      this.pendingStore.removePath(projectCsprojPath, path.relative(projectDir, oldPath));
      fs.renameSync(oldPath, newPath);
      const relNew = path.relative(projectDir, newPath);
      if (relNew && !relNew.startsWith('..')) {
        this.pendingStore.addFolder(projectCsprojPath, relNew);
      }
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('Move failed: ' + (e as Error).message);
      return false;
    }
  }
}
