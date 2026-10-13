import { execFile } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

export function windowsSystemExecutable(
  name: "whoami.exe" | "icacls.exe" | "rundll32.exe" | "powershell.exe",
): string {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root) throw new Error("缺少 Windows 系统目录，无法安全启动系统工具。");
  if (name === "powershell.exe") return join(root, "System32", "WindowsPowerShell", "v1.0", name);
  return join(root, "System32", name);
}

/** Protect the new credential directory before any tokens are written. */
export async function ensurePrivateDirectory(
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    return;
  }
  const options = { windowsHide: true, timeout: 10000, encoding: "utf8" as const, signal };
  const current = await run(
    windowsSystemExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    options,
  );
  const sid = current.stdout.match(/"(S-1-[0-9-]+)"/)?.[1];
  if (!sid) throw new Error("无法确定当前 Windows 用户，未保存 Google 凭据。");
  // New files inherit only the current user's full-control grant from this directory.
  await run(
    windowsSystemExecutable("icacls.exe"),
    [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
    options,
  );
  const verify =
    "$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath $env:PI_ANTIGRAVITY_PRIVATE_DIRECTORY; if (-not $acl.AreAccessRulesProtected) { throw 'Credential directory inherits public permissions' }; foreach ($rule in $acl.Access) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $env:PI_ANTIGRAVITY_PRIVATE_SID) { throw 'Credential directory is readable by another principal' } }";
  await run(
    windowsSystemExecutable("powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", verify],
    {
      ...options,
      env: {
        ...process.env,
        PI_ANTIGRAVITY_PRIVATE_DIRECTORY: directory,
        PI_ANTIGRAVITY_PRIVATE_SID: sid,
      },
    },
  );
  signal?.throwIfAborted();
}
