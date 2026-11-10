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

## 静态证据与边界

- 插件身份及启动方式由上述独立清单直接确认，属于静态文件证据；静态分析本身不能证明业务请求已经成功。
- 旧 `connectors` 与 `connectors-marketplace` 目录未发现绿联实现；其中 `zspace-nas` 属于极空间，不作为绿联证据。
- 本次 WorkBuddy `app.asar` REA 调查的父证据为 `ev_47cb60080813f0fbe96f62b8179e968927d4057d3dbd3c0fb4fd884571648a13`。该调查仅选择三个文件，覆盖为 `partial`，并记录 `integrity mismatch`，因此不据此声称已完整恢复 WorkBuddy 实现。
- 未逆向或重写专有 NAS 协议。能否访问具体业务能力，仍以安装的 CLI、当前认证和 NAS 支持情况的实际验证为准。
