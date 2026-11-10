# Codex 绿联云连接器

在 Codex 中读写绿联 NAS 文件、上传和下载文件，以及管理容器、下载任务和应用。连接器通过 MCP 调用绿联官方 `unc` CLI，支持的操作由 CLI、NAS 固件和访问令牌权限共同决定，没有额外的只读开关。

这是社区项目。本项目不附带官方 CLI，也不保存或分发访问令牌。每位使用者都需要安装 `unc`，并在自己的电脑上授权自己的 NAS。WorkBuddy 已在同一电脑完成授权时，可以复用该用户的 CLI 登录缓存，无需保持 WorkBuddy 运行。

## Windows 安装

准备好 Git、[Node.js 22 或更新版本](https://nodejs.org/)及 Codex，并确认终端能运行 `codex` 命令。NAS 需要支持绿联开放 CLI 通道。

### 1. 下载项目

在 PowerShell 中执行：

```powershell
git clone https://github.com/xudong7587/ugreen-nas-mcp.git
cd ugreen-nas-mcp
npm ci --ignore-scripts
```

### 2. 安装绿联官方 CLI

若已安装 `unc`，可跳过此步。以下命令运行[绿联官方安装脚本](https://file1-cn.ugnas.com/nas-cli/install.ps1)：

```powershell
irm "https://file1-cn.ugnas.com/nas-cli/install.ps1" | iex
```

CLI 默认安装到当前用户的 `.local\bin`。下文使用完整路径，因此不必等待 PATH 更新。

### 3. 授权自己的 NAS

在自己的 NAS 管理界面创建开放平台访问令牌，按用途授予查询或读写方法权限，然后在本机终端交互登录：

```powershell
& "$env:USERPROFILE\.local\bin\unc.exe" auth login
```

按提示填写自己的 NAS 地址和令牌。地址支持局域网 HTTPS 地址（需包含端口）或完整 UGLink 地址。令牌只在本机输入，无需发送到聊天或写进项目文件。已有 WorkBuddy 授权时，可直接检查连接：

```powershell
& "$env:USERPROFILE\.local\bin\unc.exe" auth status --check --format json
```

确认返回 `authenticated: true` 且 `opencli.connected: true`。`--check` 会真实联网校验；未加此参数时只检查本地缓存。

连接成功不代表令牌拥有每个业务方法的权限。写操作被 NAS 拒绝时，按错误中的方法名检查授权，必要时更换具有所需权限的令牌并重新登录。部分应用管理操作还需要管理员权限。

### 4. 注册到 Codex

在项目目录执行：

```powershell
& .\scripts\install.ps1
```

脚本会备份原有 Codex 配置，保留其他 MCP 配置，并注册名为 `ugreen-nas` 的服务。若设置了 `CODEX_HOME`，脚本使用该目录中的配置。项目目录就是服务运行目录，安装后请保留；移动目录后重新运行安装脚本。

重启 Codex，在“设置 → MCP servers”中查看 `ugreen-nas`。也可以在聊天中输入 `/mcp` 查看连接状态。入口说明见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=app)。

在新聊天中直接说：

- “看看绿联云有哪些共享文件夹。”
- “在绿联云里搜索名字包含‘合同’的 PDF。”
- “查看 NAS 的存储卷容量和容器状态。”
- “把这个 NAS 文件下载到我指定的本机文件夹，然后帮我分析。”
- “把我指定的本机文件上传到这个 NAS 文件夹，同名时自动改名。”
- “在这个 NAS 文件夹里创建一个子目录，把我指定的文件移进去。”
- “把这条链接交给 NAS 下载到我指定的目录。”

## 提供的工具

1.1.0 提供 18 个工具，保留原有 8 个工具的接口。

| 工具 | 用途 |
| --- | --- |
| `ugreen_connection_status` | 查看登录状态，默认真实联网检查 |
| `ugreen_list_files` | 列出个人/共享根目录或指定文件夹，支持分页 |
| `ugreen_file_stat` | 查询文件或目录元数据 |
| `ugreen_read_file` | 分段读取文本，每次最多 256 KiB；二进制或不完整 UTF-8 字节段返回 Base64 |
| `ugreen_search` | 按名称搜索，可限定目录和后缀 |
| `ugreen_search_results` | 根据搜索任务继续获取结果 |
| `ugreen_download_file` | 下载到用户指定的本机绝对路径，默认拒绝覆盖 |
| `ugreen_nas_info` | 查询存储、容器、镜像、Compose、已装应用和实时负载 |
| `ugreen_upload_file` | 从本机绝对路径上传到 NAS，支持冲突处理和校验 |
| `ugreen_create_directory` | 创建目录，可按需创建父目录和设置八进制权限 |
| `ugreen_create_file` | 创建文件并可写入初始文本，默认要求文件不存在 |
| `ugreen_write_file` | 覆盖、追加或按字节偏移写入文本 |
| `ugreen_copy_file` | 复制到指定 NAS 目录，支持冲突处理 |
| `ugreen_move_file` | 移动到指定 NAS 目录，或在同一目录中重命名 |
| `ugreen_delete_file` | 删除指定文件或目录，默认不递归、移入回收站 |
| `ugreen_restore_file` | 从回收站路径恢复文件 |
| `ugreen_cli_help` | 查看允许的业务命令帮助，无需认证 |
| `ugreen_execute` | 执行允许的官方 CLI 业务命令，覆盖文件、Docker、下载、应用和控制面板等功能 |

上传、复制和移动的 `on_conflict` 可选 `rename`、`skip`、`replace`；上传默认 `rename`。覆盖需要用户明确要求。创建目录默认权限为 `0755`，创建文件默认权限为 `0644`。创建文件的初始文本最多 16 KiB，写入文本每次最多 256 KiB，均按 UTF-8 字节计；`patch` 写入必须指定 `offset`。`ugreen_write_file` 只写入已存在的文件，新文件使用 `ugreen_create_file` 或上传。

专用文件写工具均支持 `dry_run`。通用工具 `ugreen_execute` 接收业务叶命令 `command`、字符串数组 `arguments`、可选文本 `stdin`，以及默认 `false` 的 `dry_run`。先用 `ugreen_cli_help` 确认当前 CLI 的具体参数；通用工具的 `--yes` 按命令要求放在 `arguments` 中，专用写工具自动处理 CLI 确认参数。

`ugreen_execute` 只开放已实现的业务命令，包含 `file`、`docker`、`download`、`app`、`ctl`、`storage`、`network`、`taskmgr`、`search` 和 `doctor`。它不执行 shell，也不开放令牌导出、切换认证、升级或卸载 CLI 等本机管理操作。当前官方 CLI 的存储、网络和任务管理器接口只提供查询；控制面板写操作包括创建用户、向自建群组追加成员。连接器不提供 CLI 尚未公开的功能，例如修改文件 ACL。

通用工具的命令和参数清单依据官方 `unc 0.1.61`，覆盖 99 个业务叶命令。CLI 将来新增的命令或参数，需要同步更新连接器清单。

## 写操作与结果核对

每次操作按用户给定的对象和范围执行。删除、覆盖、启停服务等重要操作先用 `dry_run: true` 核对影响；已有明确业务授权时可继续执行，超出范围再向用户确认。连接器开发和升级的授权，不包含修改或删除用户现有 NAS 文件来测试。

预演可能由 NAS 处理，也可能由 CLI 返回本地计划，以返回说明为准；预演不表示已经执行，也不保证真实操作成功。`--yes` 仅处理 CLI 确认，不提升令牌权限。写操作失败、超时或断线后应先查询当前状态，不自动重试，避免重复创建或修改。批量结果需逐项检查 `success`，异步任务应核实终态后再报告完成。

实测部分新文件创建预演会因目标尚不存在而返回 `NotFound`；这不能单独证明令牌只读，也不能证明真实创建一定失败。连接器保留原始错误，不把预演失败改成真实执行。

跨目录移动时，`destination` 必须是目标目录；同目录重命名时使用纯新文件名。永久删除需要显式设置 `permanent: true` 并有对应授权；递归删除需要显式设置 `recursive: true`。创建共享注册项后，CLI 没有注销接口，清理共享应在 NAS 管理界面完成，不能用删除文件代替。

目录列表和搜索可能有多页，需根据返回的分页字段继续查询；搜索使用 `task_id` 和 `next_offset`。容器查询最多返回一页 100 项，进程和服务查询返回按 CPU 排序的前 20 项。

先列出根目录，再使用结果中的路径。`/volume1` 等卷根路径不能代替共享文件夹路径。工具保留官方 CLI 的 JSON 结构，64 位数值可能以字符串返回。

不同固件、套件版本和令牌权限支持的功能不同。遇到权限或兼容性错误时，查看返回的 `error_detail` 与 `compatibility_hint`；部分方法在旧固件上不可用，重复登录不会补齐功能。

## 维护与移除

已安装的用户在原项目目录升级：

```powershell
git pull --ff-only
npm ci --ignore-scripts
& .\scripts\install.ps1
```

然后重启 Codex，使其重新加载 18 个工具。现有 CLI 登录缓存可以继续使用；增加写工具不会自动扩大令牌权限。

运行测试：

```powershell
npm test
```

自动化测试通过模拟 CLI 校验工具、参数和错误处理，不修改真实 NAS 文件。

检查真实 MCP 连接和 NAS 根目录查询：

```powershell
npm run check
```

此检查需要已授权的 NAS，只打印检查状态和结果数量，不打印文件名或内容。

移除 Codex 中的注册：

```powershell
& .\scripts\install.ps1 -Remove
```

这会保留项目文件和 CLI 登录缓存。授权失效后，在本机重新运行 `unc auth login --force`，或在 WorkBuddy 的绿联云连接器中重新连接。两端共用同一用户的 CLI 缓存，登出会同时影响两端。

项目默认使用用户目录下的 `.local/bin/unc.exe`（Windows）或 `.local/bin/unc`。自定义安装位置可给 MCP 进程设置 `UGREEN_UNC_BIN`，值必须是绝对路径。服务使用 CLI 缓存认证，不使用继承环境中的 `UNC_NAS_TOKEN`、`UNC_NAS_URL` 或 `UNC_NAS_INSECURE`。

连接方式的调查记录见 [investigation.md](investigation.md)。请勿将 `.unc` 认证缓存、Codex 配置备份或 NAS 私人数据提交到公开仓库。

本适配器按 [MIT 许可证](LICENSE)发布；绿联官方 CLI 需单独获取，适用其自身的使用条款。
