import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { detectLanAddress, firstLanAddress } from "../src/server/lan";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` };
}

function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 };
}

describe("firstLanAddress", () => {
  it("skips loopback, link-local and IPv6 addresses", () => {
    expect(
      firstLanAddress({
        lo: [v4("127.0.0.1", true)],
        apipa: [v4("169.254.10.20")],
        wifi: [v6("fe80::1"), v4("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });

  it("returns null when the machine has no network address", () => {
    expect(firstLanAddress({ lo: [v4("127.0.0.1", true)] })).toBeNull();
    expect(firstLanAddress({})).toBeNull();
  });
});

describe("detectLanAddress", () => {
  it("returns a reachable-looking IPv4 address or null, and never loopback", async () => {
    const address = await detectLanAddress();
    if (address !== null) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(address.startsWith("127.")).toBe(false);
      expect(address).not.toBe("0.0.0.0");
    }
  });
});
