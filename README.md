# Codex 绿联云连接器

在 Codex 中浏览和搜索绿联 NAS 文件、读取文本、下载文件到电脑，以及查询 NAS 状态。连接器通过 MCP 调用绿联官方 `unc` CLI，NAS 操作均为只读；下载会在本机创建文件，默认拒绝覆盖已有文件。

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

在自己的 NAS 管理界面创建开放平台访问令牌，授予需要的只读方法权限，然后在本机终端交互登录：

```powershell
& "$env:USERPROFILE\.local\bin\unc.exe" auth login
```

按提示填写自己的 NAS 地址和令牌。地址支持局域网 HTTPS 地址（需包含端口）或完整 UGLink 地址。令牌只在本机输入，无需发送到聊天或写进项目文件。已有 WorkBuddy 授权时，可直接检查连接：

```powershell
& "$env:USERPROFILE\.local\bin\unc.exe" auth status --check --format json
```

确认返回 `authenticated: true` 且 `opencli.connected: true`。`--check` 会真实联网校验；未加此参数时只检查本地缓存。

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

## 提供的工具

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

目录列表和搜索可能有多页，需根据返回的分页字段继续查询；搜索使用 `task_id` 和 `next_offset`。容器查询最多返回一页 100 项，进程和服务查询返回按 CPU 排序的前 20 项。

先列出根目录，再使用结果中的路径。`/volume1` 等卷根路径不能代替共享文件夹路径。工具保留官方 CLI 的 JSON 结构，64 位数值可能以字符串返回。

不同固件、套件版本和令牌权限支持的功能不同。遇到权限或兼容性错误时，查看返回的 `error_detail` 与 `compatibility_hint`；部分方法在旧固件上不可用，重复登录不会补齐功能。

## 维护与移除

运行测试：

```powershell
npm test
```

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
