import { describe, expect, it } from "vitest";
import { chooseFlow, parseUserAgent, type Capabilities } from "../src/shared/platform";

const UA = {
  iosSafari174: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  iosSafari173: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1",
  // Newer Safari freezes the OS version in the UA; Version/ is the real signal.
  iosSafari26: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  iosFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15",
  iosInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0",
  iosWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidChrome141: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  androidChrome135: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  androidChrome120: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  androidEdge: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
  androidWebView: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  androidFacebook: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
  samsungInternet: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  samsungChromeOldUa: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  samsungFirefox: "Mozilla/5.0 (Android 14; Mobile; SM-S918B; rv:130.0) Gecko/130.0 Firefox/130.0",
  desktopChrome141: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  desktopFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  desktopSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

const FULL: Capabilities = { credentialsGet: true, digitalCredential: true };
const NO_DC: Capabilities = { credentialsGet: true, digitalCredential: false };
const NONE: Capabilities = { credentialsGet: false, digitalCredential: false };

function choose(ua: string, caps: Capabilities = FULL, model?: string) {
  return chooseFlow(parseUserAgent(ua, { model }), caps);
}

describe("parseUserAgent", () => {
  it("reads OS, browser and version", () => {
    expect(parseUserAgent(UA.iosSafari174)).toEqual({ os: "ios", browser: "safari", version: 17.4, inApp: null, samsungDevice: false });
    expect(parseUserAgent(UA.androidChrome141)).toEqual({ os: "android", browser: "chrome", version: 141, inApp: null, samsungDevice: false });
    expect(parseUserAgent(UA.samsungInternet)).toMatchObject({ os: "android", browser: "samsung-internet", version: 26, samsungDevice: true });
    expect(parseUserAgent(UA.desktopChrome141)).toMatchObject({ os: "desktop", browser: "chrome", version: 141 });
    expect(parseUserAgent(UA.androidEdge)).toMatchObject({ browser: "edge" });
    expect(parseUserAgent(UA.iosChrome)).toMatchObject({ os: "ios", browser: "chrome" });
  });

  it("takes Safari's version from Version/, not the frozen OS version", () => {
    expect(parseUserAgent(UA.iosSafari26).version).toBe(26);
  });

  it("spots in-app browsers and bare webviews", () => {
    expect(parseUserAgent(UA.iosInstagram).inApp).toBe("Instagram");
    expect(parseUserAgent(UA.androidFacebook).inApp).toBe("Facebook");
    expect(parseUserAgent(UA.androidWebView).inApp).toBe("an app");
    expect(parseUserAgent(UA.iosWebView).inApp).toBe("an app");
    expect(parseUserAgent(UA.iosSafari174).inApp).toBeNull();
  });

  it("recognises a Samsung phone from the UA or from the client-hint model", () => {
    expect(parseUserAgent(UA.samsungChromeOldUa).samsungDevice).toBe(true);
    expect(parseUserAgent(UA.androidChrome141).samsungDevice).toBe(false);
    expect(parseUserAgent(UA.androidChrome141, { model: "SM-S918B" }).samsungDevice).toBe(true);
    expect(parseUserAgent(UA.androidChrome141, { model: "Pixel 8" }).samsungDevice).toBe(false);
  });
});

describe("chooseFlow", () => {
  it("iOS Safari 17.4+ -> Flow A (Apple Wallet)", () => {
    expect(choose(UA.iosSafari174)).toEqual({ supported: true, flow: "dc-mdoc", alternatives: [] });
    expect(choose(UA.iosSafari26)).toMatchObject({ supported: true, flow: "dc-mdoc" });
    // Safari is not blocked on the DigitalCredential global alone; the attempt decides.
    expect(choose(UA.iosSafari174, NO_DC)).toMatchObject({ supported: true, flow: "dc-mdoc" });
  });

  it("Android Chrome 141+ -> Flow B (Google Wallet), with Samsung Wallet as an alternative", () => {
    expect(choose(UA.androidChrome141)).toEqual({ supported: true, flow: "dc-openid4vp", alternatives: ["annex-b"] });
  });

  it("Samsung -> Flow C (Samsung Wallet)", () => {
    expect(choose(UA.samsungInternet)).toEqual({ supported: true, flow: "annex-b", alternatives: [] });
    expect(choose(UA.samsungChromeOldUa)).toEqual({ supported: true, flow: "annex-b", alternatives: ["dc-openid4vp"] });
    expect(choose(UA.androidChrome141, FULL, "SM-S918B")).toEqual({ supported: true, flow: "annex-b", alternatives: ["dc-openid4vp"] });
    // Flow C needs no browser support, so even Firefox on a Samsung phone works.
    expect(choose(UA.samsungFirefox, NONE)).toEqual({ supported: true, flow: "annex-b", alternatives: [] });
  });

  it("refuses in-app browsers with a clear instruction", () => {
    const ios = choose(UA.iosInstagram);
    expect(ios).toMatchObject({ supported: false, code: "IN_APP_BROWSER", title: "Open this page in Safari", alternatives: [] });
    expect(ios.supported ? "" : ios.message).toContain("Instagram");
    expect(choose(UA.androidFacebook)).toMatchObject({ supported: false, code: "IN_APP_BROWSER", title: "Open this page in Chrome" });
    expect(choose(UA.androidWebView)).toMatchObject({ supported: false, code: "IN_APP_BROWSER" });
  });

  it("refuses non-Safari browsers and old iOS on iPhone", () => {
    expect(choose(UA.iosChrome)).toMatchObject({ supported: false, code: "IOS_NOT_SAFARI" });
    expect(choose(UA.iosFirefox)).toMatchObject({ supported: false, code: "IOS_NOT_SAFARI" });
    expect(choose(UA.iosSafari173)).toMatchObject({ supported: false, code: "IOS_TOO_OLD" });
    expect(choose(UA.iosSafari174, NONE)).toMatchObject({ supported: false, code: "DC_API_MISSING" });
  });

  it("handles Chrome 128-140: works with the flag on, explains the flag when it is off", () => {
    expect(choose(UA.androidChrome135, FULL)).toMatchObject({ supported: true, flow: "dc-openid4vp" });
    const off = choose(UA.androidChrome135, NO_DC);
    expect(off).toMatchObject({ supported: false, code: "DC_API_FLAG", alternatives: ["annex-b"] });
    expect(off.supported ? "" : off.message).toContain("chrome://flags#web-identity-digital-credentials");
  });

  it("refuses old Chrome and non-Chrome Android browsers, still offering Samsung Wallet", () => {
    expect(choose(UA.androidChrome120)).toMatchObject({ supported: false, code: "CHROME_TOO_OLD", alternatives: ["annex-b"] });
    expect(choose(UA.androidFirefox)).toMatchObject({ supported: false, code: "ANDROID_NOT_CHROME", alternatives: ["annex-b"] });
    expect(choose(UA.androidEdge)).toMatchObject({ supported: false, code: "ANDROID_NOT_CHROME" });
    expect(choose(UA.androidChrome141, NONE)).toMatchObject({ supported: false, code: "DC_API_MISSING" });
  });

  it("sends desktop visitors to their phone, offering cross-device only on Chrome 141+", () => {
    expect(choose(UA.desktopChrome141)).toMatchObject({ supported: false, code: "DESKTOP", alternatives: ["dc-openid4vp", "dc-mdoc"] });
    expect(choose(UA.desktopFirefox)).toMatchObject({ supported: false, code: "DESKTOP", alternatives: [] });
    expect(choose(UA.desktopSafari)).toMatchObject({ supported: false, code: "DESKTOP", alternatives: [] });
  });
});
