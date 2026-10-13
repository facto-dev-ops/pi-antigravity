import "./register-ts.mjs";
import { build } from "esbuild";
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ANTIGRAVITY_MODELS } = await import("../src/models/models.ts");
const { OAUTH_NETWORK_DOMAINS } = await import("../src/desktop/host-fetch.ts");

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  target: "node22.19",
  external: ["@earendil-works/*", "@mariozechner/*", "typebox", "typebox/*"],
  legalComments: "eof",
  sourcemap: false,
};

await build({
  ...shared,
  entryPoints: ["src/desktop/plugin-main.ts"],
  outfile: "desktop/main.js",
  format: "cjs",
});

await build({
  ...shared,
  entryPoints: ["src/desktop/native-extension.ts"],
  outfile: "desktop/agent-extension.mjs",
  format: "esm",
  banner: {
    js: "import { createRequire as __desktopCreateRequire } from 'node:module'; const require = __desktopCreateRequire(import.meta.url);",
  },
});

let configuredModels = ANTIGRAVITY_MODELS.map((model) => ({
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  supportsImages: model.input?.includes("image") === true,
  thinkingLevels: Object.entries(model.thinkingLevelMap || {})
    .filter(([, value]) => value !== null)
    .map(([key]) => key),
  defaultThinkingLevel: model.id.startsWith("gpt-oss-")
    ? "medium"
    : model.id.startsWith("claude-")
      ? "high"
      : "low",
}));

const savedConfigPath = resolve(root, "desktop/antigravity-models.json");
if (existsSync(savedConfigPath)) {
  try {
    const saved = JSON.parse(readFileSync(savedConfigPath, "utf8"));
    if (Array.isArray(saved.models) && saved.models.length > 0) {
      configuredModels = saved.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImages: m.supportsImages !== false,
        thinkingLevels: m.thinkingLevels || ["low"],
        defaultThinkingLevel: m.defaultThinkingLevel || "low",
      }));
    }
  } catch (err) {
    console.warn("Could not load saved antigravity-models.json during build:", err);
  }
}

const manifest = {
  schemaVersion: 1,
  id: "local.pi-antigravity.desktop",
  name: "Antigravity for Desktop",
  version: "0.2.7",
  description: "全局 Google OAuth 服务与 Gemini native 直连，包含完整模型选择与设置窗口。",
  author: "new-Beginner; based on Rahul Arya's pi-antigravity",
  license: "MIT",
  homepage: "https://github.com/new-Beginner/pi-antigravity/tree/desktop-release/desktop",
  repository: "https://github.com/new-Beginner/pi-antigravity",
  categories: ["developer-tools", "community"],
  changelog: "0.2.7: restore upstream OAuth client configuration for zero-configuration login; keep personal account tokens and state out of releases. / 恢复原 OAuth 客户端配置，个人登录令牌与状态不进入发布包。",
  safetyNotes: "Includes upstream OAuth application client configuration, not user login tokens. This client configuration may trigger repository secret scanning and is not a user-account credential. Unofficial Google integration. Host stores user tokens; prompts and tool data go to Google Cloud Code Assist. Trusted Agent code has no OS sandbox. Model settings write to the plugin directory. Use only authorized accounts.",
  i18n: {
    en: {
      name: "Antigravity for Desktop",
      description: "Google OAuth and native Cloud Code Assist chat with a model selection and settings panel; no local proxy required.",
      safetyNotes: "Includes upstream OAuth application client configuration, not user login tokens. This client configuration may trigger repository secret scanning and is not a user-account credential. Unofficial Google integration. Host stores user tokens; prompts and tool data go to Google Cloud Code Assist. Trusted Agent code has no OS sandbox. Model settings write to the plugin directory. Use only authorized accounts.",
    },
    "zh-CN": {
      name: "Antigravity for Desktop",
      description: "Google OAuth 与 Cloud Code Assist 原生聊天，提供模型选择和设置面板，无需本地反代。",
      safetyNotes: "包含上游 OAuth 应用客户端配置，不包含用户登录令牌；客户端配置仍可能触发仓库密钥扫描，并非个人账号凭据。非 Google 官方集成。宿主保存用户令牌，提示词和工具数据发送至 Google Cloud Code Assist；受信任 Agent 代码无 OS 沙箱。模型设置写入插件目录。仅使用有权访问的账户。",
    },
  },
  main: "main.js",
  ui: {
    title: { en: "Antigravity model settings", "zh-CN": "Antigravity 模型选择与设置" },
    panel: "panel.html",
    shape: "panel",
  },
  contributes: {
    agentExtensions: ["agent-extension.mjs"],
    providers: [
      {
        id: "antigravity",
        name: "Antigravity",
        vendorKey: "antigravity",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        apiStyle: "google_generative_ai",
        authKind: "oauth",
        oauth: {
          loginLabel: "使用 Google 登录 Antigravity",
          isSubscription: true,
        },
        models: configuredModels,
      },
    ],
  },
  permissions: [
    "provider.register",
    "provider.oauth",
    "agent.extension",
    "net.fetch",
    "ui.panel",
  ],
  net: {
    domains: OAUTH_NETWORK_DOMAINS,
  },
  engines: {
    piDesktop: ">=0.17.0",
  },
  activationEvents: ["onStartup"],
};

await writeFile(resolve(root, "desktop/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(resolve(root, "desktop/package.json"), JSON.stringify({
  name: "pi-antigravity-desktop",
  version: manifest.version,
  private: true,
  type: "commonjs",
}, null, 2) + "\n");
await copyFile(resolve(root, "LICENSE"), resolve(root, "desktop/LICENSE"));
await copyFile(resolve(root, "node_modules/undici/LICENSE"), resolve(root, "desktop/UNDICI-LICENSE"));
await writeFile(
  resolve(root, "desktop/THIRD-PARTY-NOTICES.txt"),
  "Based on Rahularya01/pi-antigravity 0.10.0 (MIT), commit d59d22bfebd9e44f2fd4a31bf5954a23fb9b043a.\nIncludes undici 8.11.2 (MIT) bundled for provider OAuth.\nHost-provided Pi modules are not bundled.\n",
);

console.log("Built Desktop 0.2.7: restored default OAuth application client; personal tokens remain host-managed.");
