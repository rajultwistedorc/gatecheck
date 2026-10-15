import { describe, expect, it } from "vitest";
import { classifyWalletError, extractWalletData } from "../src/shared/walletData";

describe("extractWalletData", () => {
  it("passes a string through for both protocols, as the integration guide describes", () => {
    expect(extractWalletData("org-iso-mdoc", "o2dkb2NUeXBl")).toBe("o2dkb2NUeXBl");
    expect(extractWalletData("openid4vp", "eyJhbGciOiJFQ0RILUVTIn0..a.b.c")).toBe("eyJhbGciOiJFQ0RILUVTIn0..a.b.c");
  });

  it("reads data.response for OpenID4VP when the browser returns an object, as the sample app does", () => {
    expect(extractWalletData("openid4vp", { response: "eyJ.jwe" })).toBe("eyJ.jwe");
    expect(extractWalletData("openid4vp-v1-unsigned", { response: "eyJ.jwe" })).toBe("eyJ.jwe");
  });

  it("sends an mdoc object as JSON, as the sample app does", () => {
    expect(extractWalletData("org-iso-mdoc", { response: "o2dk" })).toBe('{"response":"o2dk"}');
    expect(extractWalletData("openid4vp", { vp_token: { cred1: "x" } })).toBe('{"vp_token":{"cred1":"x"}}');
  });

  it("returns null when there is nothing to send", () => {
    for (const nothing of ["", null, undefined, 42]) expect(extractWalletData("openid4vp", nothing)).toBeNull();
  });
});

describe("classifyWalletError", () => {
  it("treats a lost user gesture as retryable, not as the visitor declining", () => {
    const err = new DOMException("The request is not allowed: it requires transient activation.", "NotAllowedError");
    expect(classifyWalletError(err)).toBe("retry");
  });

  it("treats a dismissed or declined prompt as cancelled", () => {
    expect(classifyWalletError(new DOMException("The user denied the request.", "NotAllowedError"))).toBe("cancelled");
    expect(classifyWalletError(new DOMException("Aborted", "AbortError"))).toBe("cancelled");
  });

  it("treats everything else as the wallet being unavailable", () => {
    expect(classifyWalletError(new DOMException("No handler", "NotSupportedError"))).toBe("unavailable");
    expect(classifyWalletError(new DOMException("offline", "NetworkError"))).toBe("unavailable");
    expect(classifyWalletError(new TypeError("digital is not a valid option"))).toBe("unavailable");
    expect(classifyWalletError("boom")).toBe("unavailable");
    expect(classifyWalletError(null)).toBe("unavailable");
  });
});
