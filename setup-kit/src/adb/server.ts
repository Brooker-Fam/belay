// Phones through an adb server, over TCP (Tango's AdbServerClient and its Node connector): what
// the command-line runner and CI use. The server holds the USB connection and the keys.

import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import type { Connector } from "./tango.js";

export function adbServer(host: string, port: number): Connector {
  const client = new AdbServerClient(new AdbServerNodeTcpConnector({ host, port }));
  return {
    devices: async () => {
      const devices = await client.getDevices(["unauthorized", "offline", "device"]);
      return devices.map((d) => ({ serial: d.serial, state: d.state }));
    },
    connect: (serial) => client.createAdb({ serial }),
    waitFor: (serial) => client.waitFor({ serial }, "device"),
  };
}
