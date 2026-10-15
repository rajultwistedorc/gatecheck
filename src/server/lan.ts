import { createSocket } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** The first IPv4 address that is neither loopback nor link-local. */
export function firstLanAddress(interfaces: Interfaces = networkInterfaces()): string | null {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal && !info.address.startsWith("169.254.")) return info.address;
    }
  }
  return null;
}

function usable(address: string): boolean {
  return address !== "0.0.0.0" && !address.startsWith("127.") && !address.startsWith("169.254.");
}

/**
 * This machine's address on the local network, i.e. the one a phone on the same Wi-Fi can
 * reach. Used in mock mode so a QR code shown on http://localhost still works from a phone.
 *
 * A laptop usually has virtual adapters as well (WSL, VirtualBox, VPNs) that a phone cannot
 * reach, so rather than taking the first address, this asks the operating system which
 * interface it would use to reach the outside world. Connecting a UDP socket only selects
 * a route: nothing is sent. 192.0.2.1 is a reserved documentation address.
 */
export function detectLanAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (address: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(address && usable(address) ? address : firstLanAddress());
    };
    const timer = setTimeout(() => finish(null), 500);
    socket.once("error", () => finish(null));
    try {
      socket.connect(9, "192.0.2.1", () => finish(socket.address().address));
    } catch {
      finish(null);
    }
  });
}
