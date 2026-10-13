# Antigravity OAuth 客户端配置检查

## 结论

用户授权检查当前源码和发布包中为什么存在 Google OAuth Client ID / Client Secret。本次没有修改登录实现、历史提交、权限、扫描保护或安装文件，也没有继续推送。审计范围是 OAuth 默认值来源、Desktop 打包路径、运行时用户令牌边界和现有安全检查的覆盖范围，不是全仓库安全审计。

确认两项内置默认值都来自上游 pi-antigravity 0.10.0，源码和两个 Desktop 运行文件中的解码值均一致。它们不是此次新加入的个人账号令牌。上游是有意保留共享客户端默认配置，而不是构建时意外读取用户配置。Client ID 是 OAuth 应用标识，通常不是秘密；Client Secret 不能仅因上游公开就认定无需发布审查。

上游注释称默认值是 Google 的公开 Antigravity 桌面客户端。该注释是代码作者的说明，不等同于本次独立验证了 Google 客户端注册类型、归属、可分发许可或第三方使用授权。不能据此简单称 GitHub 告警是误报，也没有证据仅凭这两项就认定发生了个人账号凭据泄露。

## 范围与样本

- 上游基线：`d59d22bfebd9e44f2fd4a31bf5954a23fb9b043a`。
- 当前检查提交：`7e08e8a0c81490f0a3e8cb3550f2abcf8fa39899`。
- 前一个本地提交：`6400ef2455a366ecc44488f8824448e256b5d8ac`。
- 插件版本：`0.2.4`。
- 安装包：`desktop/dist/local.pi-antigravity.desktop-0.2.4.piplug`。
- SHA-256：`b3808eeef982fd6d3d47ea16288bfc829c4a37fa81a99dc78a3f03a68796196e`。
- 授权依据：当前会话用户要求“为啥会有，请你检查”；仅检查该工作区源码及其发布包，不访问真实账号存储、不发起 Google 授权或令牌请求。

## Evidence → Finding → Path

| 证据 | 观察结果 | 结论与路径 |
| --- | --- | --- |
| E1：`src/auth/oauth.ts:24–35` | `CLIENT_ID`、`CLIENT_SECRET` 先读环境变量，没有值时使用 `atob(...)` 内置默认值。注释解释默认桌面客户端用途。 | F1：这是显式代码回退逻辑，不是个人令牌文件被读取。Path：环境变量 → 缺省回退 → OAuth 客户端配置。 |
| E2：Git 基线与 TypeScript AST 比对 | 两项默认值在上游、前一个本地提交、当前源码及两个运行文件中一致。只解析静态字符串，不执行 OAuth 模块，也不输出值。 | F2：来源可追溯至上游；不是本次新注册的 OAuth 应用或新增账号令牌。 |
| E3：`src/desktop/plugin-main.ts:1–11`、`src/desktop/provider-oauth.ts:1`、`scripts/build-desktop.mjs:12–37` | Desktop 主入口调用 provider-oauth，后者直接导入上游 OAuth 模块；构建设置 `bundle: true`。 | F3：上游常量作为实际登录依赖进入 `main.cjs`；AST 确认 `agent-extension.mjs` 也保留相同默认值。Path：源码依赖 → esbuild bundle → 插件安装包。 |
| E4：`src/auth/oauth.ts:334–368, 410–418` | 登录授权 URL 使用 Client ID；授权码交换和刷新请求发送 Client ID / Client Secret 到令牌端点。 | F4：这些值确实可达并参与认证流程，不是无效字符串；直接删除会改变登录和刷新行为，需重新设计并验证。 |
| E5：`src/desktop/provider-oauth.ts:12–29, 41–58, 114–115` | 用户 access/refresh token 来自宿主交入或 Google 响应，再交回宿主凭据接口；本模块不写 `auth.json`。 | F5：应用客户端配置与用户账号令牌是不同的数据。仅据本次告警不能认定个人令牌已被打进包。 |
| E6：`.piplug` 文件清单及内容比对 | 包仅含 LICENSE、README.md、THIRD-PARTY-NOTICES.txt、UNDICI-LICENSE、agent-extension.mjs、main.cjs、manifest.json、panel.html；两个运行文件与本地逐字节一致。没有 auth.json、accounts.json、settings.json、antigravity-models.json 或 .env。 | F6：没有发现常见账号状态文件被打包；这不是对所有可能形式的秘密作完整排查。 |
| E7：`scripts/security-check.ts:19–79` 与重新执行 `npm run security-check` | 该脚本验证脱敏、回环地址、HTTPS 域名校验、转义和诊断上下文隔离；执行通过。它没有扫描源码、历史或安装包中的密钥。 | F7：此前“安全检查通过”不能表述为“没有密钥”或“可安全公开”。发布流程缺少独立秘密扫描门禁。 |

Base64 是可逆编码，不是加密，不能作为保密或规避 GitHub 扫描的措施。不会通过拆分字符串、改编码或关闭保护解决该问题。

## 已执行验证与限制

1. 比较上游、前一个本地提交和当前源码的两项默认声明：一致。
2. 使用项目已安装的 TypeScript AST 解析默认 `atob` 静态字符串，比较当前源码、`desktop/main.cjs`、`desktop/agent-extension.mjs` 与上游解码结果：全部一致；未打印值。
3. 检查当前 shell 的 `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` 和兼容的 `NOAGY_*` 两项覆盖变量是否设置：均未设置。没有读取其他进程的环境或用户真实凭据。
4. 只读检查 `.piplug` 清单、SHA-256 与运行文件字节一致性：通过。
5. 重新执行 `npm run security-check`：通过，但仅代表该行为测试集通过。
6. 本机 PATH 未发现 Semgrep，因此没有运行 Semgrep 或 CodeQL。使用定向静态检查和人工数据流验证，没有为本次检查安装额外工具。
7. 没有调用 Google API，未验证共享客户端当前有效性、Google 是否接受无 Client Secret 的 PKCE 请求，也未验证客户端第三方使用授权。

## 最小修复选项（尚未实施）

如果目标是“仓库和安装包不含内置 Client Secret”，应移除共享 secret 回退，明确采用自有 OAuth 客户端配置或经过服务方确认支持的无 secret 公共客户端流程。不能只删常量或不传字段后声称原登录仍可用；当前源码的授权码交换和刷新实际使用该字段。

修复需同时覆盖：

- 源码配置与缺配置时明确报错；配置不得进入源码、日志或安装包。
- Desktop 宿主能否安全提供配置，不能假设插件继承任意 shell 环境变量。
- 登录、刷新、取消、错误响应和缺配置测试。
- 源码、构建产物、安装包及待推送历史的独立秘密扫描。
- 保留现有提交作为备份，另建干净发布分支；仅追加“删除密钥”提交无法清除先前待上传提交中的内容。不擅自 reset、改标签或强推。
- 修复发布时推进 Desktop 版本，并同步构建清单、文档、标签和安装包文件名。

如果选择沿用上游共享客户端，则需先确认可使用和公开的依据，再走 GitHub 正式例外审批，而不是把上游注释当作自动豁免。

## 当前发布状态

本地检查完成。此前 GitHub Desktop 分支和标签推送被保护拒绝，Release 未创建；本次没有解锁或重试。官方中心收录尚未提交，仍需源码上传以及 GitHub App 对新仓库的授权。运行代码未作更改；本文件仅记录发现，不表示用户已批准任何修复或发布例外。
