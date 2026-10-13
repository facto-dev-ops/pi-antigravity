# Antigravity Desktop 0.2.5 OAuth 凭据修复报告

## 摘要与授权范围

按用户确认“不应该内置密钥”，移除该工作区插件的上游 OAuth 默认客户端 ID 和密钥；登录、刷新均改为读取运行时配置。修复范围为 TypeScript OAuth 实现、入口导出、相关测试、Desktop 构建产物与发布门禁，不是全仓库安全审计。没有读取用户账号令牌，没有调用真实 Google 授权流程或放行 GitHub 密钥告警。前次来源分析保留在 [0.2.4 审计报告](2026-10-13_源码审计-antigravity-oauth-report.md)，该文档描述的是修复前快照。

**兼容性变化：** 需自行提供有权使用且具备相应 Google scope 授权的客户端。自行创建客户端不保证 Cloud Code Assist 访问权限；原客户端签发的令牌不能保证可由新客户端刷新。不能声称原有免配置登录仍然可用。

## Evidence → Finding → Path

| 证据 | 结论 | 数据路径与修复 |
| --- | --- | --- |
| E1：`src/auth/oauth.ts` 的 `resolveOAuthClient()` 与 `src/auth/index.ts` | F1：没有客户端默认值，也没有导入时捕获凭据的常量 | 运行时环境 → 校验 → 单次操作配置快照 → Google 授权 URL / 令牌请求；缺值时在监听或网络前抛错 |
| E2：`scripts/test-oauth-config.ts` | F2：缺值、空白、单项配置、兼容名、运行时更新、授权码交换和刷新参数均受回归覆盖 | 占用回调端口仍先得到配置错误；缺配置零请求、零通知；所有网络调用为模拟 |
| E3：OAuth 错误处理与同一测试 | F3：错误回显中的本次客户端密钥、授权码、PKCE verifier、刷新/访问令牌进行脱敏 | Google 错误正文 → 已知值及 URL 编码值替换 → 通用脱敏 → 限长错误 |
| E4：`scripts/check-release-secrets.mjs` 与 `scripts/test-release-secrets.mjs` | F4：行为测试之外有独立凭据扫描 | 当前跟踪文件、包内所有文件、指定 ref 可达的不同 Git blobs → 规则扫描；常量 Base64 分片解码；不打印命中值 |
| E5：重新构建的 `desktop/main.cjs`、`desktop/agent-extension.mjs`、0.2.5 实际安装包 | F5：扫描零命中，包内没有常见账号状态文件 | 源码 → esbuild → 官方 PluginCheck / PluginPack → 实际包扫描 |
| E6：旧发布分支历史扫描命中 | F6：仅追加删除提交不足以安全推送旧历史 | 旧分支/标签本地保留；新 `desktop-release` 从清理快照作为根提交开始；推送前检查其全部可达历史，不强推、不关闭保护 |

客户端 ID 通常不是秘密，本次仍按用户要求一并去掉内置值。Base64 不提供保密；本次移除内容，而非改变编码来规避扫描。

## 已执行验证

- `npm test`：基础回归、OAuth 配置测试和凭据扫描器测试通过。
- `npm run desktop:test`：19 项适配器、24 项 native、10 项宿主 OAuth 传输回归和双语面板测试通过。
- `npm run typecheck`、`npm run lint`、`npm run security-check`、`git diff --check` 通过。
- `npm run desktop:build` 重建两个 bundle 和版本清单。
- 使用 PI-Desktop 0.18.0 实际 TrustedExtensionRunner / Google adapter 运行 `desktop:smoke`，包含构建后缺配置和刷新参数检查、工具多轮、取消、其他服务隔离与网络传输替换；模拟响应，零外网请求。
- 官方双语门禁：0 fail、8 review；面板文本枚举等 review 不等于阻止项。
- 官方 PluginCheck 通过；提示 `provider.register`、`provider.oauth`、`agent.extension`、`net.fetch` 需用户明确授权。
- 官方 PluginPack：8 个文件，2,461,541 字节。
- 实际包扫描：`PASS checked=8 findings=0`；打包前跟踪文件扫描：`PASS checked=108 findings=0`。新增报告和脚本将在提交前纳入跟踪扫描。

安装包：`desktop/dist/local.pi-antigravity.desktop-0.2.5.piplug`。

SHA-256：`230c675f0a4a7c959d65b73dd650ea74bf1a9b2d96a4df1251d2f6e9bfa89857`。

## 可复现检查

在仓库根目录执行；`PI_SCRATCH_DIR` 指向本机会话临时目录，`PI_DESKTOP_RUNTIME_DIR` 指向真实 Desktop agent-runtime。

```bash
npm test
npm run desktop:test
npm run typecheck
npm run lint
npm run security-check
npm run desktop:build
npm run desktop:smoke
npm run secrets:check
npm run secrets:check -- --package desktop/dist/local.pi-antigravity.desktop-0.2.5.piplug
npm run secrets:check -- --history desktop-release
git diff --check
```

重新打包应使用官方 PluginPack，不使用 shell ZIP。环境配置和启动注意事项见 [Desktop README](../desktop/README.md)。真实凭据不要写入源码、模型配置、日志、安装包或聊天。

## 限制与发布边界

扫描是定向启发式检查，覆盖常见 Google OAuth、GitHub token、PEM 私钥与常量 Base64；不解析任意混淆、UTF-16、嵌套归档或远端内容。浅克隆中触及缺失祖先的 ref 不能被判定完整通过；不触及浅边界的独立根提交可完整验证。本机未运行 Semgrep 或 CodeQL；没有验证真实账号在线登录和模型回复。

截至本报告生成时，插件中心已返回新 Fork 作为可绑定仓库；GitHub 上传和中心提交将在本地检查后执行，实际结果以 GitHub Release 和 `plugin_status` 为准。本报告不表示插件已获官方审核。干净发布分支不代表删除 Fork 继承的其他上游分支历史，也不代表旧本地包适合发布。
