import * as vscode from 'vscode';
import { PendingStore } from './pendingStore';
import { SolutionTreeProvider } from './tree/SolutionTreeProvider';
import { SolutionTreeDragAndDropController } from './tree/SolutionTreeDragAndDropController';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const pendingStore = new PendingStore();
  const treeProvider = new SolutionTreeProvider(context, pendingStore);
  const dragAndDropController = new SolutionTreeDragAndDropController(pendingStore, (csprojPath) =>
    treeProvider.refreshProject(csprojPath)
  );
  const view = vscode.window.createTreeView('unitySolutionExplorerView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController,
  });
  treeProvider.setTreeView(view);

  let lastRevealedPath: string | undefined;

  const tryRevealActiveFile = async (filePath: string): Promise<void> => {
    const key = treeProvider.normalizePathKey(filePath);
    if (key === lastRevealedPath) return;
    const ok = await treeProvider.revealFileInTree(filePath);
    if (ok) {
      lastRevealedPath = key;
    }
  };

  context.subscriptions.push(view);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('unitySolutionExplorer')) {
        treeProvider.refresh();
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('unitySolutionExplorer.refresh', () => {
      treeProvider.refresh();
    })
  );
  registerCommands(
    context,
    treeProvider.getPendingStore(),
    (csprojPath) => treeProvider.refreshProject(csprojPath),
    () => treeProvider.refresh()
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const uri = editor?.document?.uri;
      if (uri?.scheme === 'file') {
        void tryRevealActiveFile(uri.fsPath);
      }
    })
  );

  // 从 Unity 等外部打开文件时，可能在失焦期间已切换编辑器；切回时重试定位（不刷新树）
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) return;
      const uri = vscode.window.activeTextEditor?.document?.uri;
      if (uri?.scheme === 'file') {
        void tryRevealActiveFile(uri.fsPath);
      }
    })
  );

  const currentUri = vscode.window.activeTextEditor?.document?.uri;
  if (currentUri?.scheme === 'file') {
    const revealWithRetry = async (filePath: string, attempts = 4): Promise<void> => {
      for (let i = 0; i < attempts; i++) {
        const ok = await treeProvider.revealFileInTree(filePath);
        if (ok) {
          lastRevealedPath = treeProvider.normalizePathKey(filePath);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    setTimeout(() => {
      void revealWithRetry(currentUri.fsPath);
    }, 800);
  }
}

export function deactivate(): void {}
