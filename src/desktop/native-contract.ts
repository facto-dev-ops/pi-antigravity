export const GLOBAL_PROVIDER_ID = "plugin:local.pi-antigravity.desktop:antigravity";
export const GLOBAL_VENDOR_KEY = "antigravity";
export const TRANSPORT_HEADER = "x-pi-antigravity-transport";
export const TRANSPORT_VERSION = "native-v2";
export const PROJECT_HEADER = "x-pi-antigravity-project";
export const EFFORT_HEADER = "x-pi-antigravity-effort";
export const SESSION_HEADER = "x-pi-antigravity-session";
export const CLOUD_ORIGIN = "https://daily-cloudcode-pa.googleapis.com";

export interface HostCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountLabel?: string;
  headers?: Record<string, string>;
}

export interface OAuthRequest {
  operation: "login" | "refresh";
  providerId: string;
  loginId?: string;
  credential?: HostCredential;
}

export interface PluginHostApi {
  ui?: {
    openPanel?(): Promise<void>;
    closePanel?(): Promise<void>;
    showToast?(message: string, level?: string): Promise<void>;
  };
  net?: {
    fetch(input: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      timeoutMs: number;
    }): Promise<{ status: number; headers?: Record<string, string>; bodyText: string }>;
  };
  providers: {
    oauth: {
      notify(loginId: string, event: Record<string, unknown>): Promise<void>;
      prompt(loginId: string, input: Record<string, unknown>): Promise<string>;
    };
  };
}
