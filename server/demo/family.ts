/**
 * The demo's made-up family (docs/demo.md): a parent, a kid, a simulated phone and its apps. Every
 * name, app and number here is invented: the apps' package names are under `org.example.`, and
 * the phone numbers are in North America's 555-01xx range, which is kept for fiction. No real
 * family, app, icon or number is in it.
 */
import type { Package, PermissionCategory } from "../src/device/schemas.js";
import type { RuleSet } from "../src/family/screentime/rules.js";
import type { Section } from "../src/family/screentime/agreement.js";

export const PARENT = { name: "Jordan", username: "demo" } as const;
export const KID = "Robin";
export const PHONE_NAME = "Robin's phone";

/** The family's timezone when the computer's own can't be read. */
export const FALLBACK_ZONE = "America/New_York";

/** Belay's own application id: the simulated phone runs "Belay", like a real one. */
export const BELAY = "family.brooker.belay";

/** An app on the simulated phone, before the times it was installed and updated. */
export interface DemoApp {
  package: string;
  /** The app's name, as its (made-up) developer wrote it. */
  label: string;
  versionName: string;
  versionCode: number;
  system: boolean;
  launchable: boolean;
  /** ApplicationInfo.category: -1 none, 0 game, 1 audio, 2 video, 3 image, 4 social, 6 maps, 7 productivity. */
  category: number;
  source: Package["source"];
  permissions: PermissionCategory[];
}

const system = (pkg: string, label: string, permissions: PermissionCategory[] = [], launchable = true): DemoApp => ({
  package: pkg,
  label,
  versionName: "17",
  versionCode: 3700,
  system: true,
  launchable,
  category: -1,
  source: "preinstalled",
  permissions,
});

const fromStore = (pkg: string, label: string, versionName: string, versionCode: number, category: number, permissions: PermissionCategory[] = []): DemoApp => ({
  package: pkg,
  label,
  versionName,
  versionCode,
  system: false,
  launchable: true,
  category,
  source: "play_store",
  permissions,
});

/** The made-up phone's own apps: its dialer, texting app, home screen, keyboard and so on. */
export const SYSTEM_APPS: readonly DemoApp[] = [
  system("org.example.os.phone", "Phone", ["contacts", "call_log", "microphone"]),
  system("org.example.os.messages", "Messages", ["sms", "contacts", "camera", "microphone", "photos_media"]),
  system("org.example.os.home", "Home", [], false),
  system("org.example.os.keyboard", "Keyboard", [], false),
  system("org.example.os.settings", "Settings"),
  system("org.example.os.camera", "Camera", ["camera", "microphone", "location", "photos_media"]),
  system("org.example.os.clock", "Clock"),
  system("org.example.os.photos", "Photos", ["photos_media"]),
  system("org.example.os.browser", "Browser"),
];

/** Belay, put on the phone over adb when it was set up. */
export const BELAY_APP: DemoApp = {
  package: BELAY,
  label: "Belay",
  versionName: "0.5.0-demo",
  versionCode: 6,
  system: false,
  launchable: true,
  category: -1,
  source: "adb",
  permissions: ["device_admin"],
};

/**
 * What the simulated phone never blocks, as a real phone reports it (enforcement.never_blocked):
 * Belay, the phone app, texting, the home screen, the keyboard and Settings.
 */
export const NEVER_BLOCKED: readonly string[] = [
  BELAY,
  "org.example.os.phone",
  "org.example.os.messages",
  "org.example.os.home",
  "org.example.os.keyboard",
  "org.example.os.settings",
];

/** Left out of a pause and a schedule, as on a real phone: an alarm still rings, and texting 988 needs a keyboard. */
export const KEPT_OPEN: readonly string[] = ["org.example.os.clock", "org.example.os.keyboard"];

export const APPS = {
  pebblePath: fromStore("org.example.pebblepath", "Pebble Path", "2.3.1", 231, 0),
  cometKart: fromStore("org.example.cometkart", "Comet Kart", "1.8.0", 180, 0, ["microphone"]),
  wordGarden: fromStore("org.example.wordgarden", "Word Garden", "4.0.2", 402, 0),
  doodleDen: fromStore("org.example.doodleden", "Doodle Den", "3.5", 35, 3, ["camera", "photos_media"]),
  lyricLoop: fromStore("org.example.lyricloop", "Lyric Loop", "2.12.0", 2120, 1),
  trailMaps: fromStore("org.example.trailmaps", "Trail Maps", "3.1.0", 310, 6, ["location"]),
  busBuddy: fromStore("org.example.busbuddy", "Bus Buddy", "1.4.2", 142, 6, ["location"]),
  skyAtlas: fromStore("org.example.skyatlas", "Sky Atlas", "5.0.1", 501, -1, ["location", "camera"]),
  // Installed during the demo's week.
  fractionForest: fromStore("org.example.fractionforest", "Fraction Forest", "1.2.0", 120, 7),
  clipStream: fromStore("org.example.clipstream", "Clip Stream", "9.4.0", 940, 2, ["camera", "microphone", "photos_media", "contacts"]),
  lanternChat: fromStore("org.example.lanternchat", "Lantern Chat", "2.0.3", 203, 4, ["camera", "microphone", "contacts", "photos_media", "location"]),
} as const satisfies Record<string, DemoApp>;

/** The apps on the phone before Belay was: they're allowed when protection is turned on. */
export const FIRST_APPS: readonly DemoApp[] = [
  ...SYSTEM_APPS,
  BELAY_APP,
  APPS.pebblePath,
  APPS.cometKart,
  APPS.wordGarden,
  APPS.doodleDen,
  APPS.lyricLoop,
  APPS.trailMaps,
  APPS.busBuddy,
  APPS.skyAtlas,
];

export const GAMES: readonly string[] = [APPS.pebblePath.package, APPS.cometKart.package, APPS.wordGarden.package];

/** An app as the phone reports it (docs/protocol.md, "Package"). */
export function packageOf(app: DemoApp, firstInstall: number, lastUpdate = firstInstall): Package {
  return {
    package: app.package,
    label: app.label,
    version_name: app.versionName,
    version_code: app.versionCode,
    first_install_time: firstInstall,
    last_update_time: lastUpdate,
    system: app.system,
    updated_system: false,
    enabled: true,
    launchable: app.launchable,
    target_sdk: app.system ? 37 : 36,
    category: app.category,
    source: app.source,
    installer:
      app.source === "play_store"
        ? { installing: "com.android.vending", initiating: "com.android.vending", update_owner: "com.android.vending" }
        : {},
    permissions: [...app.permissions],
  };
}

// ── The family's rules ──────────────────────────────────────────────────

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
const EVERY_DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The first stage's rules: an hour of games on school days, an hour and a half at the weekend, school and bedtime. */
export function starterRules(ids: { games: string; school: string; bedtime: string }): RuleSet {
  return {
    limits: [{ id: ids.games, name: "Games", packages: [...GAMES], minutes: 60, by_day: { sat: 90, sun: 90 } }],
    schedules: [
      { id: ids.school, kind: "school", name: "School", days: [...WEEKDAYS], start: "08:30", end: "15:00", allow: [APPS.busBuddy.package], lock: false, skip: [] },
      { id: ids.bedtime, kind: "bedtime", name: "Bedtime", days: [...EVERY_DAY], start: "21:00", end: "07:00", allow: [], lock: true, skip: [] },
    ],
    exempt: [],
    if_unmeasured: "pause_limited",
    self_serve: null,
    warn_before: 5,
  };
}

/** The next stage: more games, a later bedtime, and a few minutes the kid can take without asking. */
export function explorerRules(ids: { games: string; school: string; bedtime: string }): RuleSet {
  return {
    limits: [{ id: ids.games, name: "Games", packages: [...GAMES], minutes: 90, by_day: { sat: 120, sun: 120 } }],
    schedules: [
      { id: ids.school, kind: "school", name: "School", days: [...WEEKDAYS], start: "08:30", end: "15:00", allow: [APPS.busBuddy.package], lock: false, skip: [] },
      { id: ids.bedtime, kind: "bedtime", name: "Bedtime", days: [...EVERY_DAY], start: "21:30", end: "07:00", allow: [], lock: true, skip: [] },
    ],
    exempt: [],
    if_unmeasured: "pause_limited",
    self_serve: { minutes: 15, times: 1 },
    warn_before: 5,
  };
}

export const STAGES = {
  starter: { name: "Starter", how: null },
  explorer: { name: "Explorer", how: "A month of keeping the agreement: the phone sleeps in the kitchen, and homework comes before games." },
  offBelay: "When you're 16, and we all agree you're ready.",
} as const;

export const AGREEMENT: readonly Section[] = [
  { title: "Where the phone sleeps", text: "The phone charges in the kitchen from bedtime until the morning." },
  { title: "New apps", text: "Ask before a new app, and say why you want it. We answer within a day, and say why." },
  { title: "Screen time", text: "Games are an hour on school days and an hour and a half at the weekend. Ask if you need more: sometimes the answer is yes." },
  { title: "If something goes wrong", text: "Tell us, or press I need help. You won't be in trouble for telling us." },
  { title: "Loosening up", text: "Every month we look at the rules together, and loosen what's working." },
];

// ── People and numbers (555-01xx: fiction) ──────────────────────────────

export const NUMBERS = {
  jordan: "+15555550101",
  grandma: "+15555550102",
  coach: "+15555550103",
  mia: "+15555550104",
  kid: "+15555550120",
  stranger: "+15555550177",
} as const;

export const CONTACTS: readonly { name: string; number: string; parent: boolean }[] = [
  { name: "Jordan", number: NUMBERS.jordan, parent: true },
  { name: "Grandma Pat", number: NUMBERS.grandma, parent: false },
  { name: "Coach Lee", number: NUMBERS.coach, parent: false },
  { name: "Mia", number: NUMBERS.mia, parent: false },
];
