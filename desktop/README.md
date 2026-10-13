# Antigravity for PI-Desktop · 0.2.6

> **0.2.5 安全变更：不再内置任何 OAuth 客户端 ID 或密钥。** 登录和刷新必须配置你有权使用的客户端。客户端必须具备 Google 所需 scope 的授权；自行创建客户端不保证获得 Cloud Code Assist 权限。旧账号令牌属于原客户端，不能保证换客户端后可刷新，必要时重新登录。
>
> **Breaking change:** No OAuth client ID or secret is bundled. Supply your own authorized client at runtime before login/refresh. Existing tokens issued to the removed upstream client may require reauthorization.

在 **设置 → 模型 → 添加 AI 服务** 中登录 Google Antigravity，使用普通模型菜单选择 Gemini、Claude 等模型。聊天请求使用 Gemini native 协议，在 Agent 进程内适配 Cloud Code Assist，**不需要 CLIProxyAPI 或本地 HTTP 反代，不修改 Desktop 安装文件**。

> 非 Google 官方集成，仅使用你有权访问的账户。需要权限 `provider.register`、`provider.oauth`、`agent.extension`、`net.fetch`、`ui.panel`，安装时须明确授权。OAuth 插件回调能够接收令牌，受信任扩展运行于 Agent 进程，不是 OS 沙箱。先检查源码再授权。
>
> 本机验证版本：PI-Desktop **0.18.0**。0.2.6 通过 Desktop 原生插件面板（`ui.panel`）提供模型勾选、拖拽排序、高级设置（思考等级／上下文／输出长度）及自定义模型 ID。使用扩展页的「打开面板」入口；CLI 适配器中的 `/antigravity.settings` 只提供入口提示，并非本安装包的打开命令。
>
> **Model settings:** The plugin supplies its own model-management panel, not the host's built-in account editor. Use **Plugins → Antigravity → Open panel**. OAuth and model availability still require your authorized Google account.
## 安装和使用

0. 在启动 PI-Desktop **之前**，将 `ANTIGRAVITY_CLIENT_ID`、`ANTIGRAVITY_CLIENT_SECRET` 设置到运行插件的进程环境中（兼容 `NOAGY_CLIENT_ID`、`NOAGY_CLIENT_SECRET`）。完全退出已有 Desktop 进程，再从带配置的环境启动。仅在另一个终端设置变量，不代表已运行的 Electron 或插件进程能够读取；快捷方式启动也不能假设继承该终端环境。不要在模型设置面板、聊天、仓库、manifest 或安装包中填写凭据。缺配置时明确报错，且不打开回调端口、不发起网络请求。
1. 在 **插件 → 菜单 → 安装插件包** 中选择 `dist/local.pi-antigravity.desktop-0.2.6.piplug`。
2. 确认五项权限：添加模型服务、运行供应商 OAuth、在 Agent 内运行代码、受 Google 域名白名单约束的网络请求、模型设置面板。启用插件；不要将插件仅限定到不包含目标会话的项目。
3. 打开 **设置 → 模型 → 添加 AI 服务**，搜索 **Antigravity**，点击“使用 Google 登录 Antigravity”。登录操作不需要提前创建或运行聊天会话。
4. 在系统浏览器中由你本人完成 Google 授权。宿主负责展示登录状态、打开授权地址和保存凭据。
5. 本机登录通过 `localhost:51121/oauth-callback` 自动完成。远程浏览器无法访问该回调时，在登录对话框粘贴完整回调 URL；不要发到聊天消息中。取消登录会中止流程。
6. 授权完成后，在扩展页面点击 Antigravity 卡片的 **打开面板**，按需选择、排序和设置模型。面板保存后如宿主未立即刷新，重新加载插件并打开新会话。

完成上述 OAuth 客户端配置后，无需添加自定义端点、填写模型 API Key、启动额外服务或运行 `/antigravity.login`、`/antigravity.model`。登录时仅启动临时 OAuth 回调监听器，它不转发聊天请求，不是反代。

也可以从插件页“加载开发文件夹”，选择当前 `desktop` 文件夹。**不要用“导入 pi 扩展”选择仓库根目录**，根目录仍声明上游 CLI 入口。

## 从 0.2.2 升级

- 安装 0.2.3，确认新增 `net.fetch` 权限，重启 Desktop 并打开新会话。保留原账号；只有 Google 返回 `invalid_grant` 时才需要重新登录。
- **为什么 0.2.2 仍可能失败**：聊天在带代理的 sidecar 中运行，令牌刷新却在独立插件进程中直接调用 Undici，不能假设它继承 sidecar 的代理。已用假刷新令牌复现约 10 秒后 `fetch failed / UND_ERR_CONNECT_TIMEOUT`。
- 新版在单次 OAuth 操作的异步上下文中使用 `pi.net.fetch`，覆盖令牌交换／刷新、用户信息和项目发现；不改全局 dispatcher，CLI 保持原有 Undici 传输，并发账号不串用网络接口。
- 网络白名单：`oauth2.googleapis.com`、`www.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.sandbox.googleapis.com`、`cloudcode-pa.googleapis.com`。浏览器授权地址仍由宿主打开。
- 请求限制为 30 秒；取消立即退回且丢弃晚到凭据。宿主 `net.fetch` 桥接不接受 `AbortSignal`，已经发送的请求可能在宿主完成或超时后才结束，取消不会保存其结果。
- 如果仍失败，请提供当前完整错误：宿主代理发生的 `ECONNRESET`／TLS 断连需要检查代理线路；401、403、429 和 `invalid_grant` 则是认证、权限或配额结果。本修复不承诺消除代理自身的故障。

## 从 0.2.1 升级

- 安装 0.2.2 更新同一插件 ID，保留原 Google OAuth 账号和现有权限，无需因本次修复重新授权。
- 更新后重启 PI-Desktop 并打开新会话，避免运行器缓存旧扩展。
- Desktop 0.18.0 在应用代理配置或恢复网络连接池时会替换全局 `fetch`。旧插件只在加载时包装，替换后不再转换 Cloud Code Assist 协议；新版在发送前恢复适配并使用宿主最新传输。
- 请求载荷钩子仅恢复包装器，不读取、修改或返回载荷，保留原 `AbortSignal`。其他服务请求不变。
- 若仍提示 `fetch failed`，检查 Desktop 网络代理设置及代理程序是否运行。本次诊断中直连 Google 超时，而经系统代理的无凭据请求可达；这不代表账户／模型已经在线验收。

## 从 0.2.0 升级

- 使用 0.2.1 安装包更新同一插件 ID，保留原有 Google OAuth 账号；本次修复不要求重新授权。
- 更新后重启 PI-Desktop 并打开新会话，确保运行器不再缓存旧扩展。
- 修复 `e.addEventListener is not a function`：旧请求钩子往返克隆了 `AbortSignal`，只在请求头钩子写入思考等级和会话 ID，保留原始取消信号。0.2.2 新增的载荷钩子不返回载荷。
- 回归脚本 `scripts/test-desktop-runtime.mjs` 传入真实 `AbortController().signal`，覆盖文本、多轮工具、流中停止、预先取消及其他服务隔离；响应仍使用模拟数据，在线回复需安装后验证。

## 从 0.1.0 升级

- 使用 0.2.0 安装包更新同一插件 ID。新增 `provider.register`、`provider.oauth` 权限，需要重新确认。
- 避免同时加载同 ID 的旧开发插件与安装包。若旧插件仍受开发目录监听，先在插件页禁用或移除该开发记录，再安装新包。
- 新版没有旧的会话登录命令，不再依赖尚未创建的会话运行时。
- 新版不会读取、迁移或删除旧版 `~/.pi/desktop-antigravity/` 中的凭据。请重新从设置页登录；若旧目录保存过真实令牌，需要清理时请自行确认后删除。

## 模型和功能

| 功能 | 行为 |
| --- | --- |
| 全局服务 | manifest 声明 `Antigravity` OAuth 服务，非会话 Agent |
| 模型目录 | 8 个上游静态对话模型，实际可用性由账户决定 |
| 认证 | 宿主加密保存令牌；OAuth 网络通过 `pi.net.fetch` 使用宿主代理 |
| 传输 | Gemini native → Cloud Code Assist 请求包装，SSE 增量解包 |
| 思考与工具 | 上游模型路由、思考配置和 Claude/GPT-OSS 工具 schema 适配 |
| 多轮对话 | 保留思考签名、函数调用和函数结果，按会话附加请求元数据 |
| 禁用/退出 | 通过插件页和模型服务设置操作，不使用斜杠命令 |

没有贡献生图专用模型或独立搜索/生图工具。该包装器在 Agent 进程生效；主进程中的独立模型调用（例如某些插件的一次性调用）不属于本版本的已验证路径。

## 凭据与安全

- OAuth 钩子只返回宿主认可的 `accessToken`、`refreshToken`、`expiresAt`、`accountLabel` 和非秘密路由请求头；不写 `auth.json`，不主动读取 Pi CLI 或旧插件令牌文件。
- 项目 ID 与专用传输标记随宿主凭据保存。聊天请求只在标记、HTTPS 域名和路径均匹配时适配；转换后移除所有内部标记和 `x-goog-api-key`，使用 OAuth Bearer 认证。
- 聊天传输禁止重定向；OAuth 网络受宿主域名白名单约束并拒绝返回的 3xx 响应。其他未标记服务的聊天请求原样传递。
- 多个会话共享包装器，不重复转换。宿主替换网络传输后，在发送前以最新传输恢复包装。最后一个运行器退出后恢复最新底层 `fetch` 并中止未完成请求；若其他扩展又包装了 `fetch`，不会在卸载时覆盖它。
- 传输层不保存令牌、不记录请求正文，也不轮换账户来绕过配额。Google 返回的权限、配额和网络错误按正常服务错误处理。
- 要退出账户，使用模型服务的退出操作。撤销 Google 服务器侧授权需在 Google 账户第三方访问管理中操作。

### 审核用能力与数据流 / Review capability matrix

| 能力 / Capability | 数据与方向 / Data flow | 边界 / Boundary |
| --- | --- | --- |
| `provider.register` | 向宿主贡献 OAuth 服务和模型目录 / Register provider and model metadata | 安装时明确授权 / Explicit install grant |
| `provider.oauth`, `net.fetch` | Google 令牌交换、刷新、用户信息及项目发现 / OAuth, user info and project discovery | 宿主网络接口、HTTPS Google 域名白名单；取消结果不落盘 / Host transport, HTTPS allowlist, cancelled credentials discarded |
| `agent.extension` | 提示词、图片与工具调用发送到 Google Cloud Code Assist / Prompts, images and tool calls sent to Google | 受信任 Agent 代码无 OS 沙箱；仅转换带标记的目标请求，不绕过配额 / Trusted code, marked requests only, no quota bypass |
| `ui.panel` | 模型目录与设置 / Model catalog and settings | 保存会直接写入插件目录中的 `antigravity-models.json` 与 `manifest.json`，并非宿主 fs 权限网关 / Writes installed plugin files directly, not through host fs gateway |

依赖来源见 `THIRD-PARTY-NOTICES.txt`：基于上游 MIT 源码，OAuth 的 Undici 随包构建，宿主 Pi 模块不打包。负面路径测试覆盖无凭据、权限缺失、错误域名、取消、并发账号隔离、未标记服务隔离及请求错误。测试通过不等于已获官方安全审批；凭据与网络能力仍需插件中心维护者独立审核。

### 发布 / Publishing

源码：[new-Beginner/pi-antigravity](https://github.com/new-Beginner/pi-antigravity)，Desktop 干净发布分支为 `desktop-release`，版本标签为 `desktop-v0.2.6`。该分支从清理后的快照开始，避免推送含旧默认凭据的祖先；旧本地历史保留，不绕过 GitHub 密钥保护。安装包名为 `local.pi-antigravity.desktop-0.2.6.piplug`。上游 CLI 的 `package.json` 版本独立保留为 0.10.0，不发布到上游 npm 包。

官方当前通过 [插件中心](https://plugins.aiuo.net) 接收源码仓库绑定和版本审核；官方发行仓库由中心生成，不手工修改 `catalog.json` 或提交插件源码 PR。GitHub Release 不代表插件已经被官方市场收录。后续版本必须同步更新构建清单版本、文档、标签和安装包名。

## 排障

- **提示 OAuth client is not configured**：在运行插件的进程环境中设置上述两个变量，完全退出并重新启动 Desktop。不要提交或发送真实值。
- **添加服务列表没有 Antigravity**：检查是否安装 0.2.0、插件已启用、`provider.register` 和 `provider.oauth` 已确认。旧版或权限不完整的插件不会提供该入口。
- **仍出现 runtime not found for session**：这是旧斜杠命令路径。停用旧插件，使用设置页的 Antigravity 登录入口。
- **登录成功但首条请求失败**：确认 `agent.extension` 权限和项目激活范围，打开新会话再试；该权限缺失时全局服务可能存在，但 native 传输不会运行。
- **刷新／登录报网络错误**：确认安装 0.2.3 且新增 `net.fetch` 已授权，检查 Desktop 的代理设置。插件不会静默回退至 Node 直连，也不要求把 token 填到 API Key 服务。
- **登录端口占用**：关闭其他进行中的 Antigravity 登录流程后重试。监听器仅使用本机回环地址。
- **Google 权限或配额错误**：检查账户权益和服务条款；插件不会突破 Google 的限制。
- **Desktop 更新后出错**：停止使用该服务，执行下述运行器测试验证新版适配行为；不要把 OAuth token 当作普通 Gemini API Key 填入其他服务。

## 开发与验证

上游源码固定：`Rahularya01/pi-antigravity` 0.10.0，提交 `d59d22bfebd9e44f2fd4a31bf5954a23fb9b043a`。CLI 入口保留；当前安装包由 `src/desktop/plugin-main.ts` 和 `src/desktop/native-extension.ts` 构建。

从仓库根目录执行：

```bash
npm install --ignore-scripts --legacy-peer-deps --registry=https://registry.npmjs.org
npm run typecheck
npm run lint
npm run desktop:test
npm test
npm run security-check
npm run oauth:test
npm run secrets:test
npm run desktop:build
PI_DESKTOP_RUNTIME_DIR='D:/Mypi_deskktop/PI-Desktop/resources/agent-runtime' npm run desktop:smoke
npm run secrets:check
# 打包后再检查实际安装包；提交后检查将要推送的全部可达历史
npm run secrets:check -- --package desktop/dist/local.pi-antigravity.desktop-0.2.6.piplug
npm run secrets:check -- --history desktop-release
```

测试需要 `PI_SCRATCH_DIR`，临时假凭据全部放在该目录。`desktop:test` 包含 19 项保留回归、24 项 native 测试和 10 项宿主 OAuth 传输测试。OAuth 测试禁用外网访问，真实登录逻辑仅使用临时本地回调监听和假回调／令牌。旧适配源码不会作为安装包入口。

`desktop:smoke` 验证构建后的 OAuth 刷新调用宿主网络接口，并加载真实本机 `TrustedExtensionRunner` 和 Google adapter，检查文本流、思考／工具、多轮回放、取消信号、其他服务隔离、多会话卸载和宿主传输替换。模拟宿主响应和模型响应，**不代替在线授权和真实模型验收**。

构建后的插件目录使用官方 `PluginCheck` 和 `PluginPack` 校验、打包；不要手工压缩为 ZIP。依赖已打包，用户安装时无需 npm。

参考：[插件开发指南](https://pi-docs.aiuo.net/zh-CN/plugin-development)。全局 OAuth 接口以本机实现为准，部分在线文档可能滞后。许可证见 `LICENSE`、`UNDICI-LICENSE`、`THIRD-PARTY-NOTICES.txt`。

## 本机验证记录

- 0.2.3 / Node 24.19.0 / PI-Desktop 0.18.0：类型检查、lint、53 项插件测试、完整上游回归、安全检查和 `git diff --check` 通过。
- 旧 0.2.2 构建用假刷新令牌复现直连 `UND_ERR_CONNECT_TIMEOUT`；新构建使用代理支持的宿主网络测试实现，在约 0.8 秒内收到 Google HTTP 400（假令牌被拒绝）。该在线测试使用桥接测试实现，不等同实际安装后的 `pi.net.fetch` 权限验收。
- 独立完整 sidecar / Desktop 自带 Node 24.20.0：使用与宿主一致的 HTTP 代理和假 OAuth 凭据，正确请求 Cloud Code Assist，约 0.4 秒收到 Google HTTP 401。另一次隔离测试先出现 TLS 建连前 `ECONNRESET`，随后宿主重试成功收到 401。
- 构建后 OAuth 回归及真实运行器模拟回归通过。官方 PluginCheck 无错误，提示四项权限需要明确授权。未自动安装、读取真实令牌或改写宿主配置；真实账号回复仍需安装后验收。

- 0.2.5：移除上游 OAuth 默认客户端；新增运行时缺配置、请求参数、错误回显脱敏及独立发布凭据扫描。扫描规则覆盖常见凭据及常量 Base64 编码，不替代全面安全审计。OAuth 和运行器测试仍使用假凭据和模拟响应，不代表真实 Google 账号在线验收。
- 0.2.6：插件中心要求主入口必须为 `main.js`；改用该文件名并添加包级 CommonJS 声明，包元数据版本随 manifest 更新。不改动 OAuth 配置和凭据边界。 / Marketplace-compatible `main.js` with explicit CommonJS package metadata; no bundled OAuth client credentials.
