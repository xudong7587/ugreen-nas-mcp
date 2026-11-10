# WorkBuddy 绿联云连接器调查

调查日期：2026-11-10。范围为已安装的 WorkBuddy 绿联云插件及其 CLI 接入方式；报告不包含用户地址、账号、令牌或 NAS 真实数据。

## 已确认的实现

WorkBuddy 的“绿联云”是 `ugreen-nas` CLI 插件，版本 `1.0.0+wb.1d83720d79cca5e7`，安装目录：

`%USERPROFILE%\.workbuddy\plugins\cache\workbuddy-connector-plugins-official\ugreen-nas\1.0.0-wb.1d83720d79cca5e7`

该目录只有四个文件：`.codebuddy-plugin/plugin.json`、`.codebuddy-plugin/marketplace.json`、`ai.workbuddy/cli.json` 和图标。没有自带 MCP 服务、JavaScript 或协议实现。`plugin.json` 明确声明中文名“绿联云”、名称 `ugreen-nas`、关键词 `cli`，最低 WorkBuddy 版本为 `4.24.0`。`%USERPROFILE%\.workbuddy\plugins\installed_plugins.json` 存在对应的用户级安装记录。

`ai.workbuddy/cli.json` 的结构与行为：

| 字段 | Windows 行为 |
| --- | --- |
| `init.win32` | 从 `https://file1-cn.ugnas.com/nas-cli/install.ps1` 下载并执行安装器；配置支持开发/测试来源与显式来源覆盖 |
| `auth.win32` | `unc.exe auth workbuddy --wait-timeout 5m` |
| `status.win32` | `unc.exe auth status --format json` |
| `unAuth.win32` | `unc.exe auth logout` |
| `statusMatch` | 匹配 JSON 中的 `authenticated: true` |
| `authUrlDomain` / `authWaitForExit` | `127.0.0.1` / `true` |
| `env.PATH` | 包含用户的 `.local/bin` |
| `versionCheck` | 运行 `unc.exe version --format json`，最低版本 `0.1.56` |

对应技能位于 `%USERPROFILE%\.workbuddy\skills\unc\SKILL.md`，附带 `references/` 产品文档。`references/global-flags.md` 第 34–41 行说明：连接器使用 CLI，缺失或版本过旧时由 WorkBuddy 在连接过程中安装 CLI 与技能。

## Codex 接入设计

复用已安装的独立 `unc.exe`，由 Codex 技能或本地适配层调用 CLI。认证默认使用当前用户的 `~/.unc/auth.json` 缓存；先执行 `unc auth status --format json`，确认已认证后再执行用户授权范围内的业务命令。

不读取、输出、导出或复制缓存中的令牌，不把认证信息写进项目文件，不额外维护一份认证。通过 CLI 统一处理 HTTPS、认证注入与业务协议。CLI 可直接独立运行，因此不需要复刻 WorkBuddy 应用或实现一套私有 NAS 协议。

## 1.1.0 读写扩展

初版 Codex 适配器只暴露了 8 个查询和下载工具，限制来自适配器自身。绿联官方 CLI 还提供文件写入、上传、复制、移动、删除及回收站恢复，以及容器、下载任务、应用和部分控制面板管理操作。

1.1.0 保留原有 8 个工具，增加 8 个专用文件写工具，以及 `ugreen_cli_help`、`ugreen_execute`，共 18 个工具。通用执行工具只允许已实现的官方 CLI 业务叶命令，以参数数组调用 CLI，不执行 shell，不开放认证导出、切换令牌、升级或卸载 CLI 等操作。没有额外的只读开关；能否完成某个写操作，由实际令牌的方法权限、账号角色和 NAS 固件决定。

写工具支持显式 `dry_run` 预演，重要操作按用户业务授权核对对象、覆盖和递归范围。预演不表示已经执行，CLI 的 `--yes` 也不会提升权限。失败或超时后先查询当前状态，不自动重试写操作。官方 CLI 未公开的功能仍无法执行，存储和网络配置不能通过这些查询接口修改。

本次验证使用模拟 CLI 测试，并执行真实连接、查询及预演检查；未修改或删除 NAS 上的现有文件。连接状态中的 `authenticated` 和 `opencli.connected` 可确认认证及连接成功，但状态返回不提供逐个方法的权限清单，不能据此声称所有写操作已经通过真实执行验证。连接器开发授权也不包含对用户现有文件进行删除或覆盖测试。

真实检查确认 18 个工具已加载，目录创建预演返回 `dry_run: true`。对不存在的合成目标，`WriteFile` 与 `CreateFile` 预演均收到 NAS 的 `NotFound`，错误详情完整保留；其中 `WriteFile` 本来就要求目标已存在，`CreateFile` 的这一预演结果不能用于判定真实创建一定失败。未为验证而改动现有 NAS 数据。

## 1.2.0 首次网页授权与使用说明

新增 `npm run connect`，由 Codex 调用官方 `unc auth workbuddy --wait-timeout 10m` 创建本机临时授权页。连接助手负责打开默认浏览器、每两秒检查登录状态以保持会话，并在用户完成网页填写后执行真实连接校验。已有有效授权直接复用；已有缓存但联网校验失败时保留缓存，不自动重置或替换凭据。

首次登录页的地址、访问令牌信息图标和 DDNS 页签已通过实际页面核对。`UGREENlink ID` 的说明指向“控制面板 > 设备连接 > 远程访问”；访问令牌说明指向“个人中心 > 本地账号 > 访问与授权”。图标属于填写帮助，失效页的 `!` 才表示该次会话已经失效。成功页仍使用“返回 WorkBuddy”的固定文案，在本项目中应返回 Codex。

官方 CLI 的 Go 元数据与内嵌前端静态调查 Evidence 为 `ev_6d0d52f9afdf479052d4a09e49c759032258c63858819f1b654f277c1619e26d`。本次仅观察用户已有页面、读取 CLI 帮助及无副作用启动计划；新的授权流程通过模拟 CLI、浏览器和时钟测试，未为验证而替换用户当前登录页或提交访问令牌。README 中只使用临时地址的格式示意，不保存真实端口或会话随机串。

## 早期静态分析记录

- 插件身份及启动方式由上述独立清单直接确认，属于静态文件证据；静态分析本身不能证明业务请求已经成功。
- 旧 `connectors` 与 `connectors-marketplace` 目录未发现绿联实现；其中 `zspace-nas` 属于极空间，不作为绿联证据。
- 本次 WorkBuddy `app.asar` REA 调查的父证据为 `ev_47cb60080813f0fbe96f62b8179e968927d4057d3dbd3c0fb4fd884571648a13`。该调查仅选择三个文件，覆盖为 `partial`，并记录 `integrity mismatch`，因此不据此声称已完整恢复 WorkBuddy 实现。
- 未逆向或重写专有 NAS 协议。能否访问具体业务能力，仍以安装的 CLI、当前认证和 NAS 支持情况的实际验证为准。
