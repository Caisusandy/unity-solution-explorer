import * as path from 'path';
import * as vscode from 'vscode';
import { parseSln } from '../parser/slnParser';
import { parseCsproj } from '../parser/csprojParser';
import { getExcludeProjects, getExtraSolutionFolders, getMergedSupportedExtensions } from '../config';
import { PendingStore } from '../pendingStore';
import { SolutionTreeItem, buildFolderTree, buildFolderTreeFromDisk } from './treeNodes';
import * as fs from 'fs';

/** project + folder 展开路径（复用 key 以兼容旧版仅 project 的持久化数据） */
const EXPANDED_NODES_KEY = 'unitySolutionExplorer.expandedProjects';

export class SolutionTreeProvider implements vscode.TreeDataProvider<SolutionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SolutionTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projectNodeByCsprojPath = new Map<string, SolutionTreeItem>();
  /** 项目目录 -> .csproj 路径，用于根据文件路径反查所属项目 */
  private projectDirByCsprojPath = new Map<string, string>();
  /** 文件绝对路径 -> 树节点，用于 reveal 定位（key 统一小写以兼容 Windows） */
  private filePathToItem = new Map<string, SolutionTreeItem>();
  private treeView: vscode.TreeView<SolutionTreeItem> | undefined;
  private pendingStore: PendingStore;
  private rootsLoadPromise: Promise<SolutionTreeItem[]> | null = null;

  /** 供 extension 层做路径去重（与内部 pathKey 一致） */
  normalizePathKey(p: string): string {
    return this.pathKey(p);
  }

  private pathKey(p: string): string {
    try {
      const resolved = path.resolve(p);
      const n = path.normalize(resolved);
      return process.platform === 'win32' ? n.toLowerCase() : n;
    } catch {
      const n = path.normalize(p);
      return process.platform === 'win32' ? n.toLowerCase() : n;
    }
  }

  setTreeView(view: vscode.TreeView<SolutionTreeItem>): void {
    this.treeView = view;
    this.context.subscriptions.push(
      view.onDidExpandElement((e) => this.saveExpanded(e.element, true)),
      view.onDidCollapseElement((e) => this.saveExpanded(e.element, false))
    );
  }

  /** 持久化/移除 project 与 folder 节点的展开状态（仅用户手动折叠时删除） */
  private saveExpanded(element: SolutionTreeItem, expanded: boolean): void {
    if ((element.type !== 'project' && element.type !== 'folder') || !element.fullPath) return;
    const key = this.pathKey(element.fullPath);
    const list = this.context.workspaceState.get<string[]>(EXPANDED_NODES_KEY) ?? [];
    const set = new Set(list);
    if (expanded) set.add(key);
    else set.delete(key);
    this.context.workspaceState.update(EXPANDED_NODES_KEY, [...set]);
  }

  /** 读取上次持久化的展开节点 key 集合 */
  private getExpandedNodeKeys(): Set<string> {
    const list = this.context.workspaceState.get<string[]>(EXPANDED_NODES_KEY) ?? [];
    return new Set(list);
  }

  /** 为树节点设置 parent，供 getParent / reveal 使用 */
  private setParents(items: SolutionTreeItem[], parent: SolutionTreeItem): void {
    for (const item of items) {
      (item as SolutionTreeItem).parent = parent;
      if (item.children?.length) {
        this.setParents(item.children, item);
      }
    }
  }

  /** 根据路径查找已注册的文件节点（含多种 key 形式兼容） */
  private findFileItemByPath(targetKey: string): SolutionTreeItem | undefined {
    let item = this.filePathToItem.get(targetKey);
    if (item) return item;
    for (const [k, v] of this.filePathToItem) {
      if (k === targetKey) return v;
      if (path.relative(k, targetKey) === '' || path.relative(targetKey, k) === '') return v;
    }
    return undefined;
  }

  /** 在内存中建立 solution 根索引，与 TreeView 共用同一次 getSolutionRoots，不触发刷新 */
  private ensureRootsLoaded(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<SolutionTreeItem[]> {
    if (!this.rootsLoadPromise) {
      this.rootsLoadPromise = this.getSolutionRoots(workspaceFolders);
    }
    return this.rootsLoadPromise;
  }

  private async ensureRootsIndexed(): Promise<void> {
    if (this.projectNodeByCsprojPath.size > 0) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return;
    await this.ensureRootsLoaded(workspaceFolders);
  }

  private fileUnderProjectDir(filePathKey: string, csprojPath: string): boolean {
    const projectDir = this.pathKey(path.dirname(csprojPath));
    const keyWithSep = projectDir + (projectDir.endsWith(path.sep) ? '' : path.sep);
    return filePathKey === projectDir || filePathKey.startsWith(keyWithSep);
  }

  /** 在全部程序集中查找实际包含该文件的 .csproj（Unity 多 csproj 同目录） */
  private async resolveCsprojContainingFile(filePath: string): Promise<string | undefined> {
    const key = this.pathKey(filePath);
    for (const csprojPath of this.projectNodeByCsprojPath.keys()) {
      if (!this.fileUnderProjectDir(key, csprojPath)) continue;
      if (await this.fileExistsInProjectTree(csprojPath, filePath)) {
        return csprojPath;
      }
    }
    return undefined;
  }

  /** 检查文件是否存在于项目树数据中（不依赖 TreeView 是否已展开） */
  private fileExistsInItems(items: SolutionTreeItem[], targetKey: string): boolean {
    for (const item of items) {
      if (item.type === 'file' && item.fullPath && this.pathKey(item.fullPath) === targetKey) {
        return true;
      }
      if (item.children?.length && this.fileExistsInItems(item.children, targetKey)) {
        return true;
      }
    }
    return false;
  }

  private async fileExistsInProjectTree(csprojPath: string, filePath: string): Promise<boolean> {
    const items = await this.loadOneProjectTree(csprojPath);
    return this.fileExistsInItems(items, this.pathKey(filePath));
  }

  /**
   * 在树中展开并定位到指定文件路径。
   * 仅当文件确实存在于树列表中时才 reveal；失败时不改动展开状态。
   */
  async revealFileInTree(filePath: string): Promise<boolean> {
    if (!this.treeView || !filePath) return false;
    const key = this.pathKey(filePath);

    await this.ensureRootsIndexed();

    let item = this.findFileItemByPath(key);
    if (item) {
      await this.treeView.reveal(item, { select: true, focus: false, expand: 3 });
      return true;
    }

    const csprojPath = await this.resolveCsprojContainingFile(filePath);
    if (!csprojPath) return false;

    const projectNode = this.projectNodeByCsprojPath.get(csprojPath);
    if (!projectNode) return false;

    await this.treeView.reveal(projectNode, { expand: true });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      item = this.findFileItemByPath(key);
      if (item) {
        await this.treeView.reveal(item, { select: true, focus: false, expand: 3 });
        return true;
      }
    }
    return false;
  }

  private registerFileItems(items: SolutionTreeItem[]): void {
    for (const item of items) {
      if (item.type === 'file' && item.fullPath) {
        this.filePathToItem.set(this.pathKey(item.fullPath), item);
      }
      if (item.children?.length) {
        this.registerFileItems(item.children);
      }
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    pendingStore: PendingStore
  ) {
    this.pendingStore = pendingStore;
    this.setupWatchers();
  }

  private setupWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
    watcher.onDidChange((uri) => {
      const csprojPath = uri.fsPath;
      const node = this.projectNodeByCsprojPath.get(csprojPath);
      if (node) this._onDidChangeTreeData.fire(node);
    });
    watcher.onDidCreate((uri) => {
      const csprojPath = uri.fsPath;
      const node = this.projectNodeByCsprojPath.get(csprojPath);
      if (node) this._onDidChangeTreeData.fire(node);
    });
    this.context.subscriptions.push(watcher);
  }

  getPendingStore(): PendingStore {
    return this.pendingStore;
  }

  refresh(): void {
    this.rootsLoadPromise = null;
    this._onDidChangeTreeData.fire();
  }

  refreshProject(csprojPath: string): void {
    const node = this.projectNodeByCsprojPath.get(csprojPath);
    if (node) {
      this._onDidChangeTreeData.fire(node);
    } else {
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: SolutionTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: SolutionTreeItem): SolutionTreeItem | undefined {
    return element.parent;
  }

  async getChildren(element?: SolutionTreeItem): Promise<SolutionTreeItem[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      return [];
    }

    if (!element) {
      return this.ensureRootsLoaded(workspaceFolders);
    }

    if (element.type === 'solution') {
      return element.children ?? [];
    }

    if (element.type === 'project' && element.projectCsprojPath) {
      const items = await this.loadOneProjectTree(element.projectCsprojPath);
      this.setParents(items, element);
      this.registerFileItems(items);
      return items;
    }

    if (element.type === 'folder') {
      return element.children ?? [];
    }

    return [];
  }

  private async getSolutionRoots(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<SolutionTreeItem[]> {
    const roots: SolutionTreeItem[] = [];
    const seenSlns = new Set<string>();
    this.projectNodeByCsprojPath.clear();
    this.projectDirByCsprojPath.clear();
    this.filePathToItem.clear();

    const expandedKeys = this.getExpandedNodeKeys();

    for (const folder of workspaceFolders) {
      const extraFolderRels = getExtraSolutionFolders(folder.uri.fsPath);
      const extraFolderNodes = this.buildExtraSolutionFolderNodes(
        folder.uri.fsPath,
        extraFolderRels,
        expandedKeys
      );
      const slnFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.sln'),
        null,
        50
      );
      for (const uri of slnFiles) {
        const slnPath = uri.fsPath;
        if (seenSlns.has(slnPath)) continue;
        seenSlns.add(slnPath);
        try {
          const content = fs.readFileSync(slnPath, 'utf-8');
          const projects = parseSln(slnPath, content);
          const excludeSet = new Set(getExcludeProjects().map((n) => n.trim()).filter(Boolean));
          const filtered =
            excludeSet.size > 0 ? projects.filter((p) => !excludeSet.has(p.name)) : projects;
          const solutionName = path.basename(slnPath, '.sln');
          const projectNodes = await this.loadProjectNodes(filtered, expandedKeys);
          const rootChildren = [...projectNodes, ...extraFolderNodes];
          const solutionItem = new SolutionTreeItem(
            solutionName,
            'solution',
            slnPath,
            rootChildren,
            vscode.TreeItemCollapsibleState.Expanded
          );
          this.setParents(rootChildren, solutionItem);
          this.registerFileItems(extraFolderNodes);
          roots.push(solutionItem);
        } catch (e) {
          roots.push(
            new SolutionTreeItem(
              path.basename(slnPath) + ' (parse failed)',
              'solution',
              slnPath,
              [],
              vscode.TreeItemCollapsibleState.None
            )
          );
        }
      }
    }

    if (roots.length === 0) {
      return [
        new SolutionTreeItem(
          'No .sln file found',
          'solution',
          '',
          undefined,
          vscode.TreeItemCollapsibleState.None
        ),
      ];
    }
    return roots;
  }

  private buildExtraSolutionFolderNodes(
    workspaceRoot: string,
    folderRels: string[],
    expandedKeys: Set<string>
  ): SolutionTreeItem[] {
    const nodes: SolutionTreeItem[] = [];
    for (const rel of folderRels) {
      const fullPath = path.join(workspaceRoot, rel);
      let stat: fs.Stats;
      try {
        if (!fs.existsSync(fullPath)) continue;
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const children = buildFolderTreeFromDisk(fullPath, expandedKeys);
      const label = path.basename(fullPath);
      const shouldExpand = expandedKeys.has(this.pathKey(fullPath));
      nodes.push(
        new SolutionTreeItem(
          label,
          'folder',
          fullPath,
          children,
          shouldExpand
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        )
      );
    }
    return nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  private async loadProjectNodes(
    projects: { name: string; absolutePath: string }[],
    expandedKeys: Set<string>
  ): Promise<SolutionTreeItem[]> {
    const nodes: SolutionTreeItem[] = [];
    for (const proj of projects) {
      try {
        if (!fs.existsSync(proj.absolutePath)) {
          nodes.push(
            new SolutionTreeItem(
              proj.name + ' (file missing)',
              'project',
              proj.absolutePath,
              [],
              vscode.TreeItemCollapsibleState.None
            )
          );
          continue;
        }
        const content = fs.readFileSync(proj.absolutePath, 'utf-8');
        const info = parseCsproj(proj.absolutePath, content, getMergedSupportedExtensions());
        const projectDir = path.dirname(proj.absolutePath);
        const csprojKey = this.pathKey(proj.absolutePath);
        const isAssemblyCSharp = path.basename(proj.absolutePath) === 'Assembly-CSharp.csproj';
        const shouldExpand = expandedKeys.has(csprojKey) || isAssemblyCSharp;
        const projectItem = new SolutionTreeItem(
          info.assemblyName || proj.name,
          'project',
          proj.absolutePath,
          undefined,
          shouldExpand
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
          proj.absolutePath
        );
        projectItem.tooltip = proj.absolutePath;
        this.projectNodeByCsprojPath.set(proj.absolutePath, projectItem);
        this.projectDirByCsprojPath.set(projectDir, proj.absolutePath);
        nodes.push(projectItem);
      } catch (e) {
        nodes.push(
          new SolutionTreeItem(
            proj.name + ' (parse failed)',
            'project',
            proj.absolutePath,
            [],
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }
    return nodes;
  }

  /**
   * 蓝本（csproj 解析）+ Pending 合并后建树，不做整盘扫描。
   */
  private async loadOneProjectTree(csprojPath: string): Promise<SolutionTreeItem[]> {
    const projectDir = path.dirname(csprojPath);
    const expandedKeys = this.getExpandedNodeKeys();
    try {
      if (!fs.existsSync(csprojPath)) {
        return [];
      }
      const content = fs.readFileSync(csprojPath, 'utf-8');
      const info = parseCsproj(csprojPath, content, getMergedSupportedExtensions());
      const blueprintFiles = info.compileItems.map((c) => c.include);
      const blueprintRels = new Set(
        blueprintFiles.map((f) => path.relative(projectDir, f)).filter((r) => !r.startsWith('..'))
      );

      this.pendingStore.prune(csprojPath, blueprintRels, projectDir);
      const pendingAfter = this.pendingStore.getPending(csprojPath);

      return buildFolderTree(
        blueprintFiles,
        projectDir,
        csprojPath,
        pendingAfter.folders,
        pendingAfter.files,
        expandedKeys
      );
    } catch {
      return [];
    }
  }
}
