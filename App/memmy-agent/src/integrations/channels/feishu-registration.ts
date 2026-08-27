import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

type FeishuRegistrationStatus = "pendingQr" | "connected" | "expired" | "error";

type FeishuRegistrationSession = {
  status: FeishuRegistrationStatus;
  controller: AbortController;
  qrCodeDataUrl?: string;
  appId?: string;
  appSecret?: string;
  domain?: "feishu" | "lark";
  errorMessage?: string;
};

export type FeishuRegistrationResponse = {
  status: FeishuRegistrationStatus;
  qrCodeDataUrl?: string;
  pollToken?: string;
  appId?: string;
  appSecret?: string;
  domain?: "feishu" | "lark";
};

const sessions = new Map<string, FeishuRegistrationSession>();

export async function startFeishuRegistration(): Promise<FeishuRegistrationResponse> {
  const pollToken = randomUUID();
  const session: FeishuRegistrationSession = {
    status: "pendingQr",
    controller: new AbortController(),
  };
  sessions.set(pollToken, session);

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void (async () => {
    try {
      const lark = await import("@larksuiteoapi/node-sdk");
      let qrCodeReady: Promise<void> | undefined;
      const result = await lark.registerApp({
        source: "memmy-agent",
        signal: session.controller.signal,
        appPreset: { name: "Memmy" },
        onQRCodeReady(info) {
          qrCodeReady = QRCode.toDataURL(info.url, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 320,
          }).then((qrCodeDataUrl) => {
            session.qrCodeDataUrl = qrCodeDataUrl;
            readySettled = true;
            resolveReady();
          });
          void qrCodeReady.catch((error) => {
            session.controller.abort();
            if (!readySettled) {
              readySettled = true;
              rejectReady(toRegistrationError(error));
            }
          });
        },
      });

      await qrCodeReady;
      session.status = "connected";
      session.appId = result.client_id;
      session.appSecret = result.client_secret;
      session.domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
    } catch (error) {
      const registrationError = toRegistrationError(error);
      session.status = registrationError.code === "expired_token" ? "expired" : "error";
      session.errorMessage = registrationError.message;
      if (!readySettled) {
        readySettled = true;
        rejectReady(registrationError);
      }
    }
  })();

  setTimeout(() => {
    session.controller.abort();
    sessions.delete(pollToken);
  }, 15 * 60 * 1000).unref();

  await ready;
  return {
    status: "pendingQr",
    qrCodeDataUrl: session.qrCodeDataUrl,
    pollToken,
  };
}

export function pollFeishuRegistration(pollToken: string): FeishuRegistrationResponse {
  const session = sessions.get(pollToken);
  if (!session) {
    return { status: "expired" };
  }
  if (session.status === "error") {
    throw new Error(session.errorMessage || "Feishu authorization failed");
  }
  if (session.status === "connected") {
    return {
      status: "connected",
      appId: session.appId,
      appSecret: session.appSecret,
      domain: session.domain,
      pollToken,
    };
  }
  return {
    status: session.status,
    qrCodeDataUrl: session.qrCodeDataUrl,
    pollToken,
  };
}

function toRegistrationError(error: unknown): Error & { code?: string } {
  if (error instanceof Error) {
    return error as Error & { code?: string };
  }
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; description?: unknown };
    const code = typeof value.code === "string" ? value.code : undefined;
    const description = typeof value.description === "string" ? value.description : undefined;
    return Object.assign(new Error(description || code || "Feishu authorization failed"), { code });
  }
  return new Error(String(error));
}
