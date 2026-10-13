# Antigravity Desktop 0.2.7 登录配置恢复与验证

## 目标、授权与结论

用户澄清要排除的是登录后保存的个人 OAuth 信息（access token、refresh token 和账号状态），不是登录流程所需的应用客户端配置，并授权“通过对话记录等手段恢复，然后测试，再重新上传”。本次只恢复该工作区的默认客户端配置、相关回归与发布元数据；不恢复、不读取、不删除本机真实账号存储，也不修改原作者仓库。前次 0.2.5–0.2.6 强制自配客户端是对目标的误解，旧报告仅代表当时实现，不再代表新版需求。

0.2.7 已从保留的 `desktop` 分支恢复 0.2.4 同一组应用客户端值，保留运行时成对覆盖与错误脱敏，恢复没有环境配置时的登录/刷新路径。默认值改为明文常量，不重新编码隐藏。客户端来源一致不证明第三方分发授权或 Google 当前在线有效性；完整密钥扫描必须继续告警，不能把个人数据检查通过描述为“没有任何密钥”。

## Evidence → Finding → Path

| 证据 | 结论 | 路径 |
| --- | --- | --- |
| E1：新测试在修复前执行失败，错误为 OAuth client is not configured | F1：误将客户端配置设为必填是免配置登录失效的直接原因 | 无环境变量 → resolveOAuthClient → 在登录前失败 |
| E2：旧 `desktop:src/auth/oauth.ts` 的静态默认值提取及 SHA-256 对比 | F2：本次恢复的是原应用配置，不是个人用户令牌 | 保留的旧 Git 提交 → 静态字符串解码 → 指纹 → 当前源码/构建请求参数 |
| E3：`scripts/test-oauth-config.ts`、`scripts/test-desktop-runtime.mjs` | F3：无环境配置的模拟登录、授权码交换、刷新和打包后的默认客户端请求参数通过 | 原默认客户端 → 模拟授权回调/令牌端点 → 假用户令牌 → 宿主凭据契约 |
| E4：`src/desktop/provider-oauth.ts` | F4：用户令牌交回宿主，不写入插件发布输入 | 宿主旧凭据或 OAuth 响应 → accessToken/refreshToken/expiresAt → 宿主保存 |
| E5：实际 0.2.7 包的 personal-data 扫描 | F5：未发现常见 Google 用户 token/JWT 形态和常见账号状态文件 | 包中全部 9 个文件 → 定向个人数据规则 → 0 findings |
| E6：实际包完整 secrets:check | F6：发现恢复的应用客户端 secret 和 ID，不能声称无密钥 | main.js → google-oauth-secret / google-oauth-client-id → 2 findings，退出 1 |

来源指纹（不记录实际客户端值）：

- client ID：`bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea`
- client secret：`1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60`

## 已执行验证

- `npm test` 通过：含恢复来源指纹、无环境变量模拟登录/刷新、自定义覆盖、部分配置拒绝、错误脱敏、个人数据规则及原完整扫描器 364 项断言与全部基础回归。
- `npm run desktop:test` 通过：19 项适配器、24 项 native、10 项宿主 OAuth 传输及双语模型面板检查。
- `npm run typecheck`、`npm run lint`、`npm run security-check`、`git diff --check` 通过。
- `npm run desktop:build` 重建；manifest、desktop/package.json 和包名版本均为 0.2.7，CLI package.json 0.10.0 独立保留。
- `desktop:smoke` 用实际 PI-Desktop 0.18.0 TrustedExtensionRunner / Google adapter 验证构建后的默认客户端刷新、native 文本、工具多轮、取消和其他服务隔离，模拟响应、零在线请求。
- 双语门禁：0 fail、8 review（既有面板枚举文本）；对应面板键、插值和安全赋值测试通过。
- 官方 PluginCheck / PluginPack 通过：9 个文件，2,462,630 字节。高风险权限仍需安装时用户明确授权。
- 实际包个人数据检查：`PASS personal-data checked=9 findings=0`。
- 实际包完整密钥检查：`FAIL checked=9 findings=2`，仅定位于 main.js 中的恢复客户端配置；没有关闭或修改完整扫描器规则。

安装包：`desktop/dist/local.pi-antigravity.desktop-0.2.7.piplug`。

SHA-256：`4438348613871418c9ac06a978ecd12587db03998ce0d5fe7a98ed46fd04cf1f`。

## 复现

在仓库根目录执行。测试临时文件仅使用 `PI_SCRATCH_DIR`，实际运行器测试另需 `PI_DESKTOP_RUNTIME_DIR` 指向本机 agent-runtime。

```bash
npm test
npm run desktop:test
npm run typecheck
npm run lint
npm run security-check
npm run desktop:build
npm run desktop:smoke
npm run privacy:check
npm run privacy:check -- --package desktop/dist/local.pi-antigravity.desktop-0.2.7.piplug
# 以下完整检查仍应报告应用客户端，不是“通过”
npm run secrets:check -- --package desktop/dist/local.pi-antigravity.desktop-0.2.7.piplug
git diff --check
```

## 限制与发布边界

个人数据检查是定向启发式，只覆盖常见 Google 用户 token/JWT 形态和常见私有文件名，不分析任意编码、混淆或未知令牌格式；不以读取真实账号令牌作比对。模拟 Google 响应不等于真实 Google 授权、账户权限或模型回复验收。没有承诺仅恢复客户端就能解决服务方限制。

本报告生成时准备普通 GitHub 推送，尚未声称重新上传成功。若平台保护拒绝，必须报告阻塞，不变更编码、不申请未确认的例外、不用 Release 资产或其他仓库绕过源代码保护。官方中心要求 sourceRef 已存在于绑定仓库，不能用旧版本标签冒充本次构建。安装包已在本地，可供用户明确授权后安装和在线验收；本次未自动安装或变更现有账号。
