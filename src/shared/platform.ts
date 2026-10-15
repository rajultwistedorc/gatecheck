// Picks the wallet flow for the visitor's browser. Pure, so it can be unit tested.
//
// The support matrix is the one in the Cloud SDK integration guide:
//   DC API (Flows A and B): Safari 17.4+ on iOS; Chrome 141+ on Android 9+ and desktop;
//                           Chrome 128-140 only with a flag; never Firefox or in-app webviews.
//   Flow C (Annex B):       any browser, via a deep link.

import type { FlowId } from "./types";

export interface PlatformInfo {
  os: "ios" | "android" | "desktop";
  browser: "safari" | "chrome" | "samsung-internet" | "firefox" | "edge" | "opera" | "other";
  /** Major.minor, e.g. 17.4 or 141. Null when it could not be read. */
  version: number | null;
  /** Name of the embedding app when the page is in an in-app browser. */
  inApp: string | null;
  samsungDevice: boolean;
}

export interface Capabilities {
  /** navigator.credentials.get exists. */
  credentialsGet: boolean;
  /** The DigitalCredential interface is exposed. */
  digitalCredential: boolean;
}

export type UnsupportedCode =
  | "IN_APP_BROWSER"
  | "IOS_NOT_SAFARI"
  | "IOS_TOO_OLD"
  | "ANDROID_NOT_CHROME"
  | "CHROME_TOO_OLD"
  | "DC_API_FLAG"
  | "DC_API_MISSING"
  | "DESKTOP";

export type FlowChoice =
  | { supported: true; flow: FlowId; alternatives: FlowId[] }
  | { supported: false; code: UnsupportedCode; title: string; message: string; alternatives: FlowId[] };

export const WALLET_NAME: Record<FlowId, string> = {
  "dc-mdoc": "Apple Wallet",
  "dc-openid4vp": "Google Wallet",
  "annex-b": "Samsung Wallet",
};

export const FLOW_LABEL: Record<FlowId, string> = {
  "dc-mdoc": "Flow A: Digital Credentials API, ISO mdoc",
  "dc-openid4vp": "Flow B: Digital Credentials API, OpenID4VP",
  "annex-b": "Flow C: OpenID4VP Annex B",
};

const IN_APP: [RegExp, string][] = [
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/Instagram/, "Instagram"],
  [/\bLine\//, "LINE"],
  [/MicroMessenger/, "WeChat"],
  [/Twitter/, "X"],
  [/LinkedInApp/, "LinkedIn"],
  [/Snapchat/, "Snapchat"],
  [/musical_ly|TikTok|BytedanceWebview/, "TikTok"],
  [/Pinterest/, "Pinterest"],
  [/\bGSA\//, "the Google app"],
];

function version(ua: string, pattern: RegExp): number | null {
  const match = pattern.exec(ua);
  if (!match) return null;
  const value = Number(`${match[1]}.${match[2] ?? "0"}`);
  return Number.isFinite(value) ? value : null;
}

export function parseUserAgent(ua: string, hints: { model?: string } = {}): PlatformInfo {
  const ios = /iPhone|iPad|iPod/.test(ua);
  const android = !ios && /Android/.test(ua);
  const os: PlatformInfo["os"] = ios ? "ios" : android ? "android" : "desktop";

  let inApp = IN_APP.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  // Generic webviews: Android marks them "; wv)"; on iOS they lack the "Safari/" token.
  if (!inApp && android && /;\s*wv\)/.test(ua)) inApp = "an app";
  if (!inApp && ios && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) inApp = "an app";

  let browser: PlatformInfo["browser"] = "other";
  let v: number | null = null;
  if (/SamsungBrowser\//.test(ua)) {
    browser = "samsung-internet";
    v = version(ua, /SamsungBrowser\/(\d+)(?:\.(\d+))?/);
  } else if (/Firefox\/|FxiOS\//.test(ua)) {
    browser = "firefox";
    v = version(ua, /(?:Firefox|FxiOS)\/(\d+)(?:\.(\d+))?/);
  } else if (/Edg\/|EdgA\/|EdgiOS\//.test(ua)) {
    browser = "edge";
    v = version(ua, /Edg(?:A|iOS)?\/(\d+)(?:\.(\d+))?/);
  } else if (/OPR\/|OPiOS\/|OPT\//.test(ua)) {
    browser = "opera";
  } else if (/DuckDuckGo|YaBrowser|UCBrowser|Brave/.test(ua)) {
    browser = "other";
  } else if (/CriOS\//.test(ua)) {
    browser = "chrome";
    v = version(ua, /CriOS\/(\d+)(?:\.(\d+))?/);
  } else if (/Chrome\//.test(ua)) {
    browser = "chrome";
    v = version(ua, /Chrome\/(\d+)/);
  } else if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    browser = "safari";
    // Version/ is Safari's own version; the OS version in the UA can be frozen.
    v = version(ua, /Version\/(\d+)(?:\.(\d+))?/);
  }

  // Chrome's reduced user agent hides the model ("Android 10; K"), so the model hint
  // from User-Agent Client Hints is used when the page could get it.
  const samsungDevice =
    android && (browser === "samsung-internet" || /\bSM-[A-Z0-9]+|SAMSUNG|\bGT-[A-Z]\d/i.test(ua) || /^SM-/i.test(hints.model ?? ""));

  return { os, browser, version: v, inApp, samsungDevice };
}

function unsupported(code: UnsupportedCode, title: string, message: string, alternatives: FlowId[] = []): FlowChoice {
  return { supported: false, code, title, message, alternatives };
}

export function chooseFlow(p: PlatformInfo, caps: Capabilities): FlowChoice {
  if (p.inApp) {
    const target = p.os === "ios" ? "Safari" : "Chrome";
    return unsupported(
      "IN_APP_BROWSER",
      `Open this page in ${target}`,
      `This page was opened inside ${p.inApp}. Wallets cannot be reached from there. Use the menu to open it in ${target}, or scan the code again with your camera.`,
    );
  }

  if (p.os === "ios") {
    if (p.browser !== "safari") {
      return unsupported("IOS_NOT_SAFARI", "Open this page in Safari", "On iPhone, Apple Wallet IDs can only be shared through Safari. Copy the link and open it there.");
    }
    if (p.version !== null && p.version < 17.4) {
      return unsupported("IOS_TOO_OLD", "Update your iPhone", "Sharing an ID from Apple Wallet on the web needs iOS 17.4 or later.");
    }
    if (!caps.credentialsGet) {
      return unsupported("DC_API_MISSING", "This browser cannot reach your wallet", "Safari did not offer the Digital Credentials feature on this device.");
    }
    return { supported: true, flow: "dc-mdoc", alternatives: [] };
  }

  if (p.os === "android") {
    // Flow C works from any browser, so a Samsung phone always has a path.
    if (p.browser === "samsung-internet") return { supported: true, flow: "annex-b", alternatives: [] };
    if (p.browser !== "chrome") {
      if (p.samsungDevice) return { supported: true, flow: "annex-b", alternatives: [] };
      return unsupported("ANDROID_NOT_CHROME", "Open this page in Chrome", "Google Wallet IDs can only be shared through Chrome on Android. Copy the link and open it there.", ["annex-b"]);
    }
    const v = p.version ?? 0;
    const dcApi = caps.credentialsGet && (v >= 141 || (v >= 128 && caps.digitalCredential) || (p.version === null && caps.digitalCredential));
    if (dcApi) {
      return p.samsungDevice
        ? { supported: true, flow: "annex-b", alternatives: ["dc-openid4vp"] }
        : { supported: true, flow: "dc-openid4vp", alternatives: ["annex-b"] };
    }
    if (p.samsungDevice) return { supported: true, flow: "annex-b", alternatives: [] };
    if (v >= 128 && v <= 140) {
      return unsupported(
        "DC_API_FLAG",
        "Update Chrome, or switch on one setting",
        "Chrome 128 to 140 needs the flag chrome://flags#web-identity-digital-credentials enabled. Chrome 141 and later needs nothing.",
        ["annex-b"],
      );
    }
    if (v >= 141) {
      return unsupported("DC_API_MISSING", "This browser cannot reach your wallet", "Chrome did not offer the Digital Credentials feature on this device.", ["annex-b"]);
    }
    return unsupported("CHROME_TOO_OLD", "Update Chrome", "Sharing an ID from Google Wallet needs Chrome 141 or later.", ["annex-b"]);
  }

  // Desktop Chrome 141+ can hand the request to a nearby phone itself, so it is offered
  // as an option, but the page is meant to be opened on the phone that holds the ID.
  const crossDevice = p.browser === "chrome" && (p.version ?? 0) >= 141 && caps.credentialsGet;
  return unsupported(
    "DESKTOP",
    "Open this on your phone",
    "Scan the QR code at the gate with the camera of the phone that holds your ID.",
    crossDevice ? ["dc-openid4vp", "dc-mdoc"] : [],
  );
}
