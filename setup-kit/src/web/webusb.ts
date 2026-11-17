// The phone over WebUSB, in Chromium-based browsers (Tango's daemon transport): the page holds
// the USB connection itself, and its own adb key, which the phone asks to allow.

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, type AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import type { DeviceEntry } from "../plan/interpreter.js";
import type { Connector } from "../adb/tango.js";

export interface WebUsbEvents {
  /** The phone will ask "Allow USB debugging?" if it doesn't know this page's key yet. */
  authenticating(): void;
  /** Waiting for the phone to come back after a restart. */
  waiting(): void;
}

export class WebUsbConnector implements Connector {
  private device: AdbDaemonWebUsbDevice | undefined;
  private adb: Adb | undefined;
  // The page's adb key, made with Web Crypto and kept in this browser (IndexedDB) for this page.
  private readonly keys = new AdbWebCredentialStore("Belay setup kit");

  constructor(
    private readonly manager: AdbDaemonWebUsbDeviceManager,
    private readonly events: WebUsbEvents,
  ) {}

  /** The browser's own dialog, in which the parent picks the phone. Needs a click. */
  async pick(): Promise<AdbDaemonWebUsbDevice | undefined> {
    const device = await this.manager.requestDevice();
    if (device !== undefined) {
      await this.forget();
      this.device = device;
    }
    return device;
  }

  get picked(): AdbDaemonWebUsbDevice | undefined {
    return this.device;
  }

  /** What `adb devices` would list: the phone picked, if any. */
  devices(): Promise<DeviceEntry[]> {
    return Promise.resolve(this.device === undefined ? [] : [{ serial: this.device.serial, state: "device" }]);
  }

  async connect(serial: string): Promise<Adb> {
    if (this.adb !== undefined && this.adb.serial === serial) return this.adb;
    const device = this.device;
    if (device?.serial !== serial) throw new Error(`the phone ${serial} isn't connected`);
    const connection = await device.connect();
    this.events.authenticating();
    const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: this.keys });
    const adb = new Adb(transport);
    this.adb = adb;
    void adb.disconnected.then(() => {
      if (this.adb === adb) this.adb = undefined;
    });
    return adb;
  }

  /** After a restart the phone shows up as a new USB device: wait for it, by its serial. */
  async waitFor(serial: string): Promise<void> {
    this.adb = undefined;
    this.events.waiting();
    for (;;) {
      const device = (await this.manager.getDevices()).find((d) => d.serial === serial);
      if (device !== undefined) {
        this.device = device;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async forget(): Promise<void> {
    const adb = this.adb;
    this.adb = undefined;
    await adb?.close().catch(() => undefined);
  }
}

/** Another program (usually adb) has the phone's USB debugging interface. */
export function isBusy(e: unknown): boolean {
  return e instanceof AdbDaemonWebUsbDevice.DeviceBusyError;
}
