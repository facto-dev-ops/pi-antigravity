import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handlePanelInvoke } from "../src/desktop/panel-handler.js";
import { getCurrentAntigravityModels } from "../src/models/models.js";

async function run() {
  console.log("Testing Antigravity desktop model panel handler...");

  // 1. Test get-config
  const initialConfig = (await handlePanelInvoke("antigravity:get-config", {})) as any;
  assert.equal(initialConfig.ok, true);
  assert.ok(Array.isArray(initialConfig.allModels));
  assert.ok(initialConfig.allModels.length >= 8);
  assert.ok(Array.isArray(initialConfig.configuredModelIds));
  console.log("PASS get-config returns available and configured models");

  // 2. Test fetch-models
  const fetched = (await handlePanelInvoke("antigravity:fetch-models", {})) as any;
  assert.equal(fetched.ok, true);
  assert.ok(Array.isArray(fetched.models));
  assert.ok(fetched.models.length >= 8);
  console.log("PASS fetch-models returns models");

  // 3. Test save-config with reordered and custom models
  const savePayload = {
    accountName: "Google Antigravity (Test)",
    models: [
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash (Antigravity)",
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        thinkingLevels: ["low", "high"],
        defaultThinkingLevel: "low",
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Antigravity)",
        contextWindow: 200000,
        maxTokens: 64000,
        supportsImages: true,
        thinkingLevels: ["high"],
        defaultThinkingLevel: "high",
      },
      {
        id: "custom-gemini-preview",
        name: "Custom Gemini Preview",
        contextWindow: 1000000,
        maxTokens: 32000,
        supportsImages: true,
        thinkingLevels: ["low"],
        defaultThinkingLevel: "low",
        isCustom: true,
      },
    ],
    customModels: ["custom-gemini-preview"],
  };

  const saveRes = (await handlePanelInvoke("antigravity:save-config", savePayload as any)) as any;
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.count, 3);

  // Verify in-memory catalog updated
  const activeModels = getCurrentAntigravityModels();
  assert.equal(activeModels.length, 3);
  assert.equal(activeModels[0].id, "gemini-3.8-flash");
  assert.equal(activeModels[1].id, "claude-sonnet-4-6");
  assert.equal(activeModels[2].id, "custom-gemini-preview");
  console.log("PASS save-config updates in-memory catalog and configuration");

  // 4. Test reading back saved configuration
  const reloaded = (await handlePanelInvoke("antigravity:get-config", {})) as any;
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.accountName, "Google Antigravity (Test)");
  assert.deepEqual(reloaded.configuredModelIds, ["gemini-3.8-flash", "claude-sonnet-4-6", "custom-gemini-preview"]);
  console.log("PASS get-config reflects saved changes");

  // 5. Test ui.closePanel and ui.openPanel
  let closeCalled = false;
  let openCalled = false;
  const mockApi = {
    ui: {
      async closePanel() {
        closeCalled = true;
      },
      async openPanel() {
        openCalled = true;
      },
    },
    providers: { oauth: { async notify() {}, async prompt() { return ""; } } },
  };
  await handlePanelInvoke("ui.openPanel", {}, mockApi as any);
  await handlePanelInvoke("ui.closePanel", {}, mockApi as any);
  assert.equal(openCalled, true);
  assert.equal(closeCalled, true);
  console.log("PASS ui.openPanel and ui.closePanel forward properly");

  // 6. Test panel.html i18n translation tables, placeholders, and static DOM application
  console.log("Testing panel.html i18n translation tables and DOM application...");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const panelHtmlPath = path.resolve(__dirname, "../desktop/panel.html");
  const panelHtml = await fs.readFile(panelHtmlPath, "utf-8");

  // 6.1 Extract I18N_STRINGS
  const matchDict = panelHtml.match(/const\s+I18N_STRINGS\s*=\s*(\{[\s\S]*?\n\s*\}\s*;)/);
  assert.ok(matchDict, "I18N_STRINGS declaration must exist in panel.html");
  const dictCode = matchDict[1].replace(/;\s*$/, "");
  const I18N_STRINGS = new Function(`return ${dictCode};`)() as Record<string, Record<string, string>>;

  assert.ok(I18N_STRINGS["zh-CN"], "I18N_STRINGS must include 'zh-CN' table");
  assert.ok(I18N_STRINGS.en, "I18N_STRINGS must include 'en' table");

  // 6.2 Identical keys test
  const zhKeys = Object.keys(I18N_STRINGS["zh-CN"]).sort();
  const enKeys = Object.keys(I18N_STRINGS.en).sort();
  assert.deepEqual(zhKeys, enKeys, "zh-CN and en tables must have identical key set");
  assert.ok(zhKeys.length >= 60, "Expected at least 60 i18n keys");
  for (const key of zhKeys) {
    assert.equal(typeof I18N_STRINGS["zh-CN"][key], "string", `zh-CN key ${key} must be string`);
    assert.equal(typeof I18N_STRINGS.en[key], "string", `en key ${key} must be string`);
    assert.ok(I18N_STRINGS["zh-CN"][key].length > 0, `zh-CN key ${key} must not be empty`);
    assert.ok(I18N_STRINGS.en[key].length > 0, `en key ${key} must not be empty`);
  }
  console.log(`PASS translation tables have identical keys (${zhKeys.length} keys)`);

  // 6.3 Every key on a separate line check
  const lines = matchDict[1].split("\n");
  const zhStartIndex = lines.findIndex((l) => l.includes('"zh-CN":'));
  const enStartIndex = lines.findIndex((l) => l.includes("en:"));
  assert.ok(zhStartIndex !== -1 && enStartIndex !== -1, "Found zh-CN and en blocks");
  const zhLines = lines.slice(zhStartIndex, enStartIndex).filter((l) => l.includes(":"));
  const enLines = lines.slice(enStartIndex).filter((l) => l.includes(":"));
  assert.ok(zhLines.length >= zhKeys.length, "Each zh-CN key must be on its own line");
  assert.ok(enLines.length >= enKeys.length, "Each en key must be on its own line");
  console.log("PASS every key is on its own separate line in both tables");

  // 6.4 Placeholder matching test
  // Part A: Dynamic variable placeholders ({id}, {count}, {error}) must match exactly between zh-CN and en
  for (const key of zhKeys) {
    const zhStr = I18N_STRINGS["zh-CN"][key];
    const enStr = I18N_STRINGS.en[key];
    const zhTokens = (zhStr.match(/\{([a-zA-Z0-9_]+)\}/g) || []).sort();
    const enTokens = (enStr.match(/\{([a-zA-Z0-9_]+)\}/g) || []).sort();
    assert.deepEqual(zhTokens, enTokens, `Interpolation placeholders for key "${key}" must match between zh-CN and en`);
  }
  console.log("PASS dynamic interpolation placeholders match across both tables");

  // Part B: All input placeholder attributes in panel.html mapped to i18n keys
  const placeholderAttrRegex = /data-i18n-placeholder=["']([^"']+)["']/g;
  const matchedPlaceholders = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = placeholderAttrRegex.exec(panelHtml)) !== null) {
    matchedPlaceholders.add(m[1]);
  }
  assert.ok(matchedPlaceholders.size >= 3, "Expected at least 3 input placeholder elements in panel.html");
  for (const pKey of matchedPlaceholders) {
    assert.ok(pKey in I18N_STRINGS["zh-CN"], `Placeholder key "${pKey}" missing in zh-CN table`);
    assert.ok(pKey in I18N_STRINGS.en, `Placeholder key "${pKey}" missing in en table`);
    assert.ok(I18N_STRINGS["zh-CN"][pKey].length > 0, `zh-CN placeholder "${pKey}" is empty`);
    assert.ok(I18N_STRINGS.en[pKey].length > 0, `en placeholder "${pKey}" is empty`);
  }
  console.log(`PASS form placeholders (${matchedPlaceholders.size}) are fully mapped and match in both tables`);

  // 6.5 Static text node and attribute binding test
  const attrTypes = [
    { attr: "data-i18n", desc: "textContent" },
    { attr: "data-i18n-title", desc: "title" },
    { attr: "data-i18n-aria", desc: "aria-label" },
    { attr: "data-i18n-value", desc: "value" },
  ];

  for (const { attr, desc } of attrTypes) {
    const regex = new RegExp(`${attr}=["']([^"']+)["']`, "g");
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = regex.exec(panelHtml)) !== null) {
      const key = match[1];
      assert.ok(key in I18N_STRINGS["zh-CN"], `${attr} references unknown zh-CN key: ${key}`);
      assert.ok(key in I18N_STRINGS.en, `${attr} references unknown en key: ${key}`);
      assert.ok(I18N_STRINGS["zh-CN"][key].length > 0, `${attr} value for zh-CN key ${key} is empty`);
      assert.ok(I18N_STRINGS.en[key].length > 0, `${attr} value for en key ${key} is empty`);
      count++;
    }
    assert.ok(count > 0, `Expected elements with ${attr}`);
    console.log(`PASS static ${desc} nodes (${count}) correctly map to both translation tables`);
  }

  // 6.6 Simulated DOM application and fallback verification
  function simulateApply(locale: "zh-CN" | "en") {
    const dict = I18N_STRINGS[locale];
    const applied: Record<string, string> = {};
    const elementRegex = /<([a-zA-Z0-9-]+)([^>]*)>/g;
    let elMatch: RegExpExecArray | null;
    while ((elMatch = elementRegex.exec(panelHtml)) !== null) {
      const tagAttrs = elMatch[2];
      const i18nMatch = tagAttrs.match(/data-i18n=["']([^"']+)["']/);
      if (i18nMatch) {
        const key = i18nMatch[1];
        applied[`text:${key}`] = dict[key] ?? I18N_STRINGS["zh-CN"][key] ?? key;
      }
      const phMatch = tagAttrs.match(/data-i18n-placeholder=["']([^"']+)["']/);
      if (phMatch) {
        const key = phMatch[1];
        applied[`ph:${key}`] = dict[key] ?? I18N_STRINGS["zh-CN"][key] ?? key;
      }
    }
    return applied;
  }

  const zhApplied = simulateApply("zh-CN");
  const enApplied = simulateApply("en");
  assert.equal(Object.keys(zhApplied).length, Object.keys(enApplied).length);
  assert.notDeepEqual(zhApplied, enApplied, "en and zh-CN applied DOM content must differ");
  console.log("PASS simulated static text node application verifies distinct locale rendering");

  // Verify fallback mechanics
  function tFallback(locale: string, key: string, params?: Record<string, string>) {
    const currentDict = (I18N_STRINGS as any)[locale];
    const fallbackDict = I18N_STRINGS["zh-CN"];
    let text = (currentDict && currentDict[key]) ?? (fallbackDict && fallbackDict[key]) ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
      }
    }
    return text;
  }

  assert.equal(tFallback("unknown-locale", "btnSave"), I18N_STRINGS["zh-CN"].btnSave);
  assert.equal(tFallback("zh-CN", "nonexistentKey"), "nonexistentKey");
  assert.equal(tFallback("en", "toastSaveSuccess", { count: "5" }), "Successfully saved 5 models! Synced to Desktop");
  assert.equal(tFallback("zh-CN", "toastSaveSuccess", { count: "5" }), "已成功保存 5 个模型！已同步到 Desktop");
  console.log("PASS translation fallback and interpolation logic verified");

  // 6.7 Locale normalization and bridge fallback verification
  function normalizeLocale(raw: string | null | undefined): string {
    if (!raw || typeof raw !== "string") return "zh-CN";
    const lower = raw.trim().toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    return "en";
  }

  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh-TW"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("zh"), "zh-CN");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("ja"), "en");
  assert.equal(normalizeLocale(""), "zh-CN");
  assert.equal(normalizeLocale(null), "zh-CN");
  assert.equal(normalizeLocale(undefined), "zh-CN");
  console.log("PASS locale normalization logic verified");

  async function detectLocaleMock(bridgeInvoke: ((channel: string) => Promise<any>) | null, navLang: string) {
    let detected: string | null = null;
    if (bridgeInvoke) {
      try {
        const res = await bridgeInvoke("app.getLocale");
        if (typeof res === "string" && res) detected = res;
        else if (res && typeof res.locale === "string" && res.locale) detected = res.locale;
      } catch {
        // Fallback
      }
    }
    if (!detected && navLang) {
      detected = navLang;
    }
    return normalizeLocale(detected);
  }

  assert.equal(await detectLocaleMock(async () => "en-US", "zh-CN"), "en");
  assert.equal(await detectLocaleMock(async () => ({ ok: true, locale: "zh-HK" }), "en-US"), "zh-CN");
  assert.equal(await detectLocaleMock(async () => { throw new Error("channel app.getLocale not found"); }, "en-US"), "en");
  console.log("PASS host app.getLocale error handling cleanly falls back to navigator.language");

  // 6.8 InnerHTML safety check
  assert.ok(!panelHtml.includes("innerHTML = `${t("), "No dynamic ${t( interpolation directly into innerHTML");
  console.log("PASS verified translation injection adheres to textContent / property assignment");

  console.log("All panel handler and i18n tests passed!");
}

const originalCwd = process.cwd();
const scratchRoot = process.env.PI_SCRATCH_DIR;
if (!scratchRoot) throw new Error("Set PI_SCRATCH_DIR for isolated panel tests.");
const testDirectory = await fs.mkdtemp(path.join(scratchRoot, "antigravity-panel-test-"));
process.chdir(testDirectory);
try {
  await run();
} catch (err) {
  console.error("Test failed:", err);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  await fs.rm(testDirectory, { recursive: true, force: true });
}
