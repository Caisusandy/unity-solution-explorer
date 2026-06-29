# Unity Solution Explorer

在 Cursor / VSCode 侧边栏按 .sln/.slnx 和 .csproj 展示 Unity 解决方案与程序集结构（如 Assembly-CSharp、Assembly-CSharp-Editor），自动忽略非 Unity 编辑文件，并支持多种资源文件的展示与右键操作。



## Screenshot / 界面预览

![Unity Solution Explorer](resources/screenshot.png)

## English

Browse Unity .sln/.slnx and .csproj in the sidebar (Cursor / VS Code). Shows solution and assembly structure (e.g. Assembly-CSharp, Assembly-CSharp-Editor), automatically ignores non-Unity editor files, and supports multiple file types with right-click actions. **v1.1.3+:** extra extensions (e.g. `.dll`) can be listed in `.vscode/unity-solution-explorer.json` (`additionalFileExtensions`) or in settings, merged with the built-in set for items under Compile/None/Content in the csproj.

**Drag and drop:** Move files/folders within the **same** assembly (same `.csproj`) by dropping onto a folder, project root, or file (drops into that file’s parent folder). A **modal confirmation** lists items before any rename on disk. You can drag items to **Chat** or the **editor** to attach/open. Multi-select is supported. Cross-assembly moves are not supported.

**Settings:** Search "Unity Solution Explorer" in Settings to configure **Exclude Projects** and **Additional File Extensions** (merged with `.vscode/unity-solution-explorer.json`).

---

## 功能概览

- **解决方案树**：自动发现 .sln/.slnx，按程序集展示；支持排除指定项目。自动忽略非 Unity 编辑文件。
- **多类型文件**：默认展示 .cs、.shader、.xml、.txt、.json（由 .csproj 的 Compile/None/Content 解析）。**1.1.3+** 可通过工作区 JSON 或设置增加扩展名（如 `.dll`），见下文「工作区配置」。
- **文件夹右键**：新建文件（含模板）、新建文件夹、重命名、删除（确认）、在系统资源管理器中打开、复制绝对路径。
- **文件右键**：重命名、删除（确认）、在资源管理器中打开所在文件夹、复制绝对路径。
- **拖拽（1.1.2+）**
  - **树内移动**：将文件或文件夹拖到同一程序集（同一 `.csproj`）下的目标文件夹、程序集根，或拖到某个文件上（表示放入该文件所在目录）。**不支持跨程序集**拖拽。
  - **移动前确认**：若会发生实际路径变更，弹出模态对话框列出待移动项（文件夹名称后带 `/`），选择「移动」后执行；「取消」则不修改磁盘。
  - **拖出到工作台**：可将树中项拖到 **聊天**、**编辑器** 等区域作为资源引用或打开文件；支持 **多选** 后一次性拖出或移动到同一目标。
  - **从内置资源管理器拖入**：可将位于当前目标程序集目录内的文件/文件夹拖入树中节点，完成移动（同样会先确认，且仅限同一程序集）。
  - **与 Unity 的关系**：移动后磁盘路径已变，`.csproj` 条目仍依赖 Unity 重新生成；插件通过 Pending 缓存与既有逻辑保持树与蓝本暂时不一致时的展示。
- **排除项目**：通过 `.vscode/unity-solution-explorer.json` 或设置中的 `excludeProjects` 排除不需显示的程序集。
- **额外文件类型（1.1.3+）**：同上 JSON 或设置中的 `additionalFileExtensions`，与默认扩展名合并；仅当对应路径出现在 csproj 的 Compile/None/Content 中时才会出现在树中。
- **项目级额外目录（1.1.3+）**：可在项目 `.vscode/settings.json` 配置 `unitySolutionExplorer.extraSolutionFolders`（如 `.cursor`、`.claude`），在每个解决方案根下与项目节点并列展示其目录树；若该文件不存在则忽略。**1.1.4+** 对多工作区与 JSONC（注释/尾逗号）读取更稳定。


## 工作区配置（.vscode/unity-solution-explorer.json）

在项目根创建或编辑该文件，可与 **设置 → Unity Solution Explorer** 中的项合并（排除列表、额外扩展名均会去重合并）。

**排除程序集示例：**

```json
{
  "excludeProjects": ["Assembly-CSharp.FirstPass", "Assembly-CSharp-Editor.FirstPass"]
}
```

**额外展示扩展名示例（如插件 DLL、asmdef 等）：**

```json
{
  "additionalFileExtensions": [".dll", ".asmdef"]
}
```

可同时使用两项：

```json
{
  "excludeProjects": ["Some.Assembly"],
  "additionalFileExtensions": [".dll", "asmdef"]
}
```

扩展名可写为 `".dll"` 或 `"dll"`（会自动规范为小写并带点）。修改 JSON 后使用侧边栏标题栏 **刷新解决方案**；若改的是 VS Code/Cursor **设置** 中的同名项，树会在保存设置后自动刷新。

**项目级额外目录示例（读取项目 .vscode/settings.json）：**

```json
{
  "unitySolutionExplorer.extraSolutionFolders": [".cursor", ".claude", "Tools/Rules"]
}
```

`unitySolutionExplorer.extraSolutionFolders` 仅支持相对项目根路径；会自动去重并过滤越界路径（如 `..`）。读取来源仅为项目 `.vscode/settings.json`，不会额外依赖 `.vscode/unity-solution-explorer.json`。

## 新建文件

右键文件夹 -> 新建文件。输入文件名（可带扩展名）；无扩展名时选择类型：.cs / .shader / .xml / .json / .txt。.cs 会生成类模板。
