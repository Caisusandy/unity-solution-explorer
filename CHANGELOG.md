# 更新日志

## 1.1.6

- **支持 .slnx 解决方案格式**（感谢 @Caisusandy 贡献）：自动发现 XML 格式的 `.slnx` 文件并解析其中的 `.csproj` 引用
- **迁移期去重**：同一目录下若同时存在同名 `.sln` 与 `.slnx`（如 `MyGame.sln` / `MyGame.slnx`），仅展示 `.slnx`，避免重复 Solution 树
- **slnx 解析改进**：修正 XML 实体解码顺序；优先使用 `DisplayName` 属性作为程序集显示名（与 `.sln` 行为一致，便于 `excludeProjects` 配置匹配）

## 1.1.5

- **修复切回 IDE 后树全部折叠**：移除窗口重新获得焦点时的自动整树刷新；folder 展开状态与 project 一并持久化到工作区，手动刷新或 csproj 变更后仍可恢复
- **收紧并修复文件定位**：仅当打开的文件确实存在于 Solution Explorer 树中时才 reveal；修复 Unity 多程序集同目录时的定位失败；切回 IDE 时仅 reveal 不整树刷新
- **编辑器同步去重**：同一文件重复获得焦点时不再重复 reveal；定位成功后才记录已定位路径
- **英文 UI**：右键菜单、设置说明、对话框与树内提示标签改为英文

## 1.1.4

- **修复项目级额外目录读取**：`unitySolutionExplorer.extraSolutionFolders` 现优先按当前工作区目录作用域读取；多根工作区下可正确匹配对应项目配置
- **增强 settings.json 兼容性**：对 `.vscode/settings.json` 读取增加 JSONC 容错（注释、尾逗号）并保留兜底路径，避免配置存在但未生效
- **目录展示稳定性优化**：当额外目录配置可解析时，解决方案根下会稳定追加对应目录树节点，不影响原有 csproj 蓝本合并逻辑

## 1.1.3

- **可配置额外文件类型**：在 `.vscode/unity-solution-explorer.json` 中增加 `additionalFileExtensions`（如 `[".dll", ".asmdef"]`），或在设置中配置 `unitySolutionExplorer.additionalFileExtensions`；与内置类型（.cs / .shader / .xml / .txt / .json）合并后，用于过滤 `.csproj` 中 Compile / None / Content 的 `Include`，刷新树后即可展示对应扩展名的条目
- **设置变更自动刷新**：修改 Unity Solution Explorer 相关工作区/用户设置后自动刷新树，无需手动点刷新（仍支持标题栏「刷新解决方案」）
- **项目级额外目录展示**：通过项目 `.vscode/settings.json` 中的 `unitySolutionExplorer.extraSolutionFolders`（如 `[".cursor", ".claude"]`）展示解决方案根额外目录树；若文件不存在则忽略

## 1.1.2

- **树视图拖拽**：在 Unity Solution Explorer 中可将文件或文件夹拖到同一程序集（同一 `.csproj`）下的其他文件夹或项目根；拖到文件节点时表示放入该文件所在目录
- **拖出到工作台**：支持将树中的文件/文件夹拖到聊天输入区、编辑器等（`text/uri-list` / `application/vnd.code.uri-list`），与内置资源管理器行为对齐；避免错误声明 `dragMimeTypes` 导致无法拖入编辑器的问题
- **从资源管理器拖入**：可将已打开工作区内、且位于当前目标程序集目录下的文件/文件夹拖入树中节点以完成移动（同样仅限同一程序集范围）
- **移动前确认**：实际会发生路径变更时弹出模态对话框，列出待移动项（文件夹名带 `/` 提示），确认「移动」后执行；取消则不改动磁盘
- **多选**：树支持多选后一次性拖拽多个项（移动或拖出到 Chat）
- **限制说明**：不支持跨程序集（跨 `.csproj`）拖拽移动；移动后 `.csproj` 蓝本仍依赖 Unity 重新生成，与既有 Pending 缓存逻辑一致

## 1.1.1

- **优化插件与展示**：新增扩展图标与详情页功能截图；描述与 README 增加英文说明，便于更多用户了解用途

## 1.1.0

- **展开状态持久化**：项目节点的展开/折叠状态会保存到工作区，重新打开 Cursor 或 IDE 后恢复上次的树结构
- **Assembly-CSharp 默认展开**：若解决方案中包含 `Assembly-CSharp.csproj`，该程序集在首次加载时默认展开
- **定位行为优化**：从其他侧边栏（如资源管理器）切换代码文件时不再强制切回 Unity Solution Explorer 视图；树定位时不再抢焦点，减轻闪跳

## 1.0.0

- **当前文件在树中定位**：打开或切换到某文件时，Unity Solution Explorer 自动展开对应程序集并定位到该文件节点，便于通过搜索打开文件后查看其在解决方案中的位置
- **移除局域网更新检查**：不再使用内网更新检查；后续更新计划通过官方商店发布

## 0.3.0

- **蓝本 + Pending 架构**：树结构仅以 csproj 解析结果与插件内待同步缓存为准，不再扫描整盘目录
- **隐藏未在 csproj 中的目录**：`.vscode`、`Library/` 等不再出现在树中
- **新建文件夹/文件**：通过插件新建的项写入 Pending 缓存并持久化到 `.vscode/unity-solution-explorer-pending.json`
- **自动合并与清理**：刷新时合并蓝本与 Pending，已进入 csproj 或磁盘已不存在的项从 Pending 移除
- **.csproj 变更与窗口切回**：监听 csproj 文件变更、窗口重新获得焦点时刷新树
- **左侧栏标题**：改为「Unity Solution Explorer」，便于与其他插件区分

## 0.2.0

- 支持 .shader、.xml、.txt、.json 等文件类型展示
- 文件夹/文件右键菜单（新建、重命名、删除、在资源管理器中打开、复制路径）
- 空文件夹在树中显示，仅刷新当前程序集，排除项目配置

## 0.1.0

- 初始版本：按 .sln/.csproj 展示 Unity 解决方案与程序集树