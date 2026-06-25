import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';

export type TreeNodeType = 'solution' | 'project' | 'folder' | 'file';

export class SolutionTreeItem extends vscode.TreeItem {
  /** 所属项目的 .csproj 绝对路径，用于定向刷新 */
  projectCsprojPath?: string;
  /** 父节点，供 TreeView.reveal 正确展开层级（VSCode 要求实现 getParent） */
  parent?: SolutionTreeItem;

  constructor(
    public readonly label: string,
    public readonly type: TreeNodeType,
    public readonly fullPath: string,
    public readonly children: SolutionTreeItem[] | undefined,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed,
    projectCsprojPath?: string
  ) {
    super(label, collapsibleState);
    this.contextValue = type;
    this.projectCsprojPath = projectCsprojPath;
    if (type === 'file') {
      this.resourceUri = vscode.Uri.file(fullPath);
      this.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(fullPath)],
      };
      this.iconPath = new vscode.ThemeIcon('file');
    } else if (type === 'folder') {
      this.resourceUri = vscode.Uri.file(fullPath);
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (type === 'project') {
      this.iconPath = new vscode.ThemeIcon('project');
    } else {
      this.iconPath = new vscode.ThemeIcon('solution');
    }
  }
}

interface FolderNode {
  name: string;
  fullPath: string;
  children: Map<string, FolderNode>;
  files: string[];
}

function pathKeyForExpand(p: string): string {
  try {
    const resolved = path.resolve(p);
    const n = path.normalize(resolved);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  } catch {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  }
}

function folderCollapsibleState(
  fullPath: string,
  expandedKeys?: Set<string>
): vscode.TreeItemCollapsibleState {
  if (expandedKeys?.has(pathKeyForExpand(fullPath))) {
    return vscode.TreeItemCollapsibleState.Expanded;
  }
  return vscode.TreeItemCollapsibleState.Collapsed;
}

function sortItems(items: SolutionTreeItem[]): SolutionTreeItem[] {
  return items.sort((a, b) => {
    const aIsDir = a.type === 'folder';
    const bIsDir = b.type === 'folder';
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

/** 在已有 FolderNode 树中确保某相对路径存在（用于合并 Pending 文件夹） */
function ensurePathExists(root: FolderNode, relativePath: string): void {
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length === 0) return;
  let current = root;
  for (const seg of segments) {
    const fullSoFar = path.join(current.fullPath, seg);
    if (!current.children.has(seg)) {
      current.children.set(seg, { name: seg, fullPath: fullSoFar, children: new Map(), files: [] });
    }
    current = current.children.get(seg)!;
  }
}

/**
 * 仅以「蓝本文件路径 + Pending 文件夹/文件」建树，不做整盘扫描。
 * @param filePaths 蓝本 + Pending 文件的绝对路径列表
 * @param baseDir 项目目录
 * @param projectCsprojPath 所属 .csproj 路径，用于子节点定向刷新
 * @param pendingFolders 待同步文件夹相对 baseDir 的路径
 * @param pendingFiles 待同步文件相对 baseDir 的路径（会转为绝对路径加入 filePaths 参与建树，此处仅用于确保父目录存在）
 */
export function buildFolderTree(
  filePaths: string[],
  baseDir: string,
  projectCsprojPath?: string,
  pendingFolders: string[] = [],
  pendingFiles: string[] = [],
  expandedKeys?: Set<string>
): SolutionTreeItem[] {
  const root: FolderNode = { name: '', fullPath: baseDir, children: new Map(), files: [] };

  for (const f of filePaths) {
    const relative = path.relative(baseDir, f);
    if (relative.startsWith('..')) continue;
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length === 0) continue;
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const fullSoFar = path.join(current.fullPath, seg);
      if (isLast) {
        current.files.push(f);
        break;
      }
      if (!current.children.has(seg)) {
        current.children.set(seg, { name: seg, fullPath: fullSoFar, children: new Map(), files: [] });
      }
      current = current.children.get(seg)!;
    }
  }

  for (const rel of pendingFolders) {
    ensurePathExists(root, rel);
  }
  for (const rel of pendingFiles) {
    const fullPath = path.join(baseDir, rel);
    if (root.files.indexOf(fullPath) === -1) {
      const segments = rel.split(path.sep).filter(Boolean);
      if (segments.length === 0) continue;
      let current = root;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        const fullSoFar = path.join(current.fullPath, seg);
        if (isLast) {
          current.files.push(fullPath);
          break;
        }
        if (!current.children.has(seg)) {
          current.children.set(seg, { name: seg, fullPath: fullSoFar, children: new Map(), files: [] });
        }
        current = current.children.get(seg)!;
      }
    }
  }

  function nodeToItems(node: FolderNode, csprojPath?: string): SolutionTreeItem[] {
    const items: SolutionTreeItem[] = [];
    for (const [, child] of node.children) {
      const childItems = nodeToItems(child, csprojPath);
      sortItems(childItems);
      items.push(
        new SolutionTreeItem(
          child.name,
          'folder',
          child.fullPath,
          childItems,
          folderCollapsibleState(child.fullPath, expandedKeys),
          csprojPath
        )
      );
    }
    for (const filePath of node.files) {
      items.push(
        new SolutionTreeItem(
          path.basename(filePath),
          'file',
          filePath,
          undefined,
          vscode.TreeItemCollapsibleState.None,
          csprojPath
        )
      );
    }
    return sortItems(items);
  }

  return nodeToItems(root, projectCsprojPath);
}

/** 递归读取磁盘目录，构建对应的树节点（目录在前，名称排序）。 */
export function buildFolderTreeFromDisk(
  baseDir: string,
  expandedKeys?: Set<string>
): SolutionTreeItem[] {
  if (!fs.existsSync(baseDir)) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(baseDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const walkDir = (dir: string): SolutionTreeItem[] => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const items: SolutionTreeItem[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const children = walkDir(fullPath);
        items.push(
          new SolutionTreeItem(
            entry.name,
            'folder',
            fullPath,
            children,
            folderCollapsibleState(fullPath, expandedKeys)
          )
        );
        continue;
      }
      if (entry.isFile()) {
        items.push(
          new SolutionTreeItem(
            entry.name,
            'file',
            fullPath,
            undefined,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }
    return sortItems(items);
  };

  return walkDir(baseDir);
}
