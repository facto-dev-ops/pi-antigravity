import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginAntigravity } from "../auth/oauth.js";
import { getCurrentAntigravityCatalog } from "../models/models.js";
import { fetchAccountUsage, formatUsageSummary } from "../usage/index.js";
import { maskEmail, redactSecrets } from "../utils/index.js";
import { DesktopAuthStore } from "./auth.js";
import { createDesktopStream } from "./stream.js";
import { windowsSystemExecutable } from "./private-directory.js";

type DesktopApi = ExtensionAPI & {
  registerAgent(definition: {
    id: string;
    name: string;
    models: unknown[];
    stream: ReturnType<typeof createDesktopStream>;
  }): void;
};
type Dependencies = {
  auth?: DesktopAuthStore;
  login?: typeof loginAntigravity;
  stream?: ReturnType<typeof createDesktopStream>;
};
const AGENT_NAME = "Antigravity (Google OAuth)";

export async function openGoogleLogin(pi: ExtensionAPI, address: string): Promise<void> {
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.google.com" ||
    url.username ||
    url.password
  ) {
    throw new Error("拒绝打开非 Google 授权地址。");
  }
  const command =
    process.platform === "win32"
      ? windowsSystemExecutable("rundll32.exe")
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  const result = await pi.exec(command, args, { timeout: 10000 });
  if (result.code !== 0) throw new Error("无法打开系统浏览器。");
}

export function createDesktopExtension(pi: DesktopApi, dependencies: Dependencies = {}): void {
  const auth = dependencies.auth || new DesktopAuthStore();
  const login = dependencies.login || loginAntigravity;
  const catalog = getCurrentAntigravityCatalog();
  if (typeof pi.registerAgent !== "function") {
    throw new Error("此 Desktop 版本不支持插件 Agent；需要 PI-Desktop 0.17.0 或更新版本。");
  }
  pi.registerAgent({
    id: "antigravity",
    name: AGENT_NAME,
    models: catalog.models,
    stream: dependencies.stream || createDesktopStream(auth),
  });

  let loggingIn = false;
  pi.registerCommand("antigravity.login", {
    description: "登录 Google Antigravity（使用独立 Desktop 凭据）",
    handler: async (_args, ctx) => {
      if (loggingIn) {
        ctx.ui.notify("此会话已有登录正在进行。", "warning");
        return;
      }
      if (!ctx.hasUI) throw new Error("Google 登录需要 Desktop 原生对话框。");
      loggingIn = true;
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      let opening: Promise<void> = Promise.resolve();
      let authorizationUrl = "";
      try {
        const credentials = await login({
          signal,
          onAuth: ({ url }) => {
            authorizationUrl = url;
            opening = openGoogleLogin(pi, url).catch(() => {
              if (!signal.aborted)
                ctx.ui.notify(
                  "无法自动打开浏览器，请从登录对话框复制 Google 授权链接。",
                  "warning",
                );
            });
          },
          onDeviceCode: () => {
            throw new Error("此集成使用浏览器 OAuth，不支持设备码登录。");
          },
          onSelect: async (prompt) => {
            const chosen = await ctx.ui.select(
              prompt.message,
              prompt.options.map((option) => option.label),
            );
            return prompt.options.find((option) => option.label === chosen)?.id;
          },
          onProgress: (message) => {
            if (!signal.aborted) ctx.ui.notify(redactSecrets(message), "info");
          },
          onPrompt: async () => {
            await opening;
            signal.throwIfAborted();
            const text = await ctx.ui.input(
              `请在系统浏览器完成 Google 授权。本机回调会自动完成；远程登录可粘贴完整回调 URL。取消将终止登录。\n授权链接：${authorizationUrl}`,
              "http://localhost:51121/oauth-callback?state=…&code=…",
            );
            if (text === undefined) {
              controller.abort();
              throw new DOMException("Login cancelled", "AbortError");
            }
            return text;
          },
        });
        signal.throwIfAborted();
        await auth.save(credentials, signal);
        ctx.ui.notify(
          `Antigravity 已登录${credentials.email ? `：${maskEmail(credentials.email)}` : ""}。运行 /antigravity.model 选择模型。`,
          "info",
        );
      } catch (error) {
        if (!signal.aborted)
          ctx.ui.notify(
            `Antigravity 登录失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            "error",
          );
      } finally {
        loggingIn = false;
        controller.abort();
      }
    },
  });

  pi.registerCommand("antigravity.status", {
    description: "检查 Antigravity 登录状态（不显示令牌）",
    handler: async (_args, ctx) => {
      const status = auth.status();
      ctx.ui.notify(
        status.signedIn
          ? `Antigravity 已登录${status.email ? `：${maskEmail(status.email)}` : ""}。`
          : "尚未登录，请运行 /antigravity.login。",
        "info",
      );
    },
  });
  pi.registerCommand("antigravity.logout", {
    description: "删除此插件保存的 Google 凭据，不影响 Pi CLI",
    handler: async (_args, ctx) => {
      if (!auth.status().signedIn) {
        ctx.ui.notify("没有可退出的 Antigravity 账户。", "info");
        return;
      }
      if (
        await ctx.ui.confirm(
          "退出 Antigravity",
          "删除此 Desktop 插件保存的全部账户凭据？不会退出浏览器或影响 Pi CLI。",
        )
      ) {
        await auth.logout(ctx.signal);
        ctx.ui.notify("已删除此插件保存的 Antigravity 凭据。", "info");
      }
    },
  });
  pi.registerCommand("antigravity.model", {
    description: "选择当前会话使用的 Antigravity 模型",
    handler: async (args, ctx) => {
      const models = ctx.modelRegistry
        .getAll()
        .filter((model) => ctx.modelRegistry.getProviderDisplayName(model.provider) === AGENT_NAME);
      if (!models.length) {
        ctx.ui.notify("此会话尚未加载 Antigravity 模型，请启用插件并打开新会话。", "error");
        return;
      }
      const selected =
        args.trim() ||
        (await ctx.ui.select(
          "选择 Antigravity 模型",
          models.map((model) => model.id),
        ));
      if (!selected) return;
      const model = models.find((candidate) => candidate.id === selected);
      if (!model || !(await pi.setModel(model))) {
        ctx.ui.notify("无法绑定该插件模型，请检查插件已启用且当前会话已重新加载。", "error");
        return;
      }
      ctx.ui.notify(`当前会话已切换到 ${model.id}。`, "info");
    },
  });
  pi.registerCommand("antigravity.models", {
    description: "查看已注册的 Antigravity 模型（实际可用性由 Google 账户决定）",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        catalog.models.map((model) => `${model.id} — ${model.name}`).join("\n"),
        "info",
      );
    },
  });
  pi.registerCommand("antigravity.settings", {
    description: "打开 Antigravity 模型选择与设置窗口",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "请在左侧插件/扩展列表点击 Antigravity 的「打开面板」，即可打开模型选择和设置窗口。",
        "info",
      );
    },
  });
  pi.registerCommand("antigravity.usage", {
    description: "查询当前 Antigravity 账户剩余配额",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(
          formatUsageSummary(await fetchAccountUsage(await auth.apiKey(ctx.signal))),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          redactSecrets(error instanceof Error ? error.message : String(error)),
          "error",
        );
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createDesktopExtension(pi as DesktopApi);
}
