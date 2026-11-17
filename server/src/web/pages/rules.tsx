/** The Rules section of a phone's page: what the phone enforces, and the forms that change it. */
import type { FC } from "hono/jsx";
import type { DeviceView } from "../../family/devices.js";
import {
  DNS_FILTERS,
  LIMITS,
  RESTRICTION_NAMES,
  SAFE_CHROME,
  SAFE_RESTRICTIONS,
  activeMaintenance,
  activePause,
  type AskAgain,
  type Decision,
  type Rules,
} from "../../family/policy.js";
import type { AppRequestView as RequestView } from "../../family/requests.js";
import { formatAgo } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

const PAUSE_CHOICES = [
  ["15", "15 minutes"],
  ["30", "30 minutes"],
  ["60", "1 hour"],
  ["120", "2 hours"],
  ["240", "4 hours"],
  ["480", "8 hours"],
  ["until", "Until I resume it"],
] as const;
export const PAUSE_MINUTES: ReadonlySet<string> = new Set(PAUSE_CHOICES.map(([value]) => value).filter((v) => v !== "until"));
export const MAINTENANCE_HOURS: ReadonlySet<string> = new Set(["1", "4", "24"]);

/** The rules' version, and whether the phone has them yet. */
export const RulesStatus: FC<{ view: View; device: DeviceView }> = ({ view, device }) => {
  if (device.policyVersion === 0) return <p class="muted">No rules yet: Belay reports what happens on this phone, and enforces nothing.</p>;
  const applied = device.enforcement;
  return (
    <p class="small">
      Rules version {device.policyVersion}
      {device.policyChangedAt !== null && <>, changed {formatAgo(device.policyChangedAt, view.now)}</>}.{" "}
      {applied?.policy_version === device.policyVersion ? (
        <span class="status ok">The phone applied them{applied.applied_at != null && <> {formatAgo(applied.applied_at, view.now)}</>}.</span>
      ) : device.policyHave === device.policyVersion ? (
        <span>The phone has them, and reports applying them at its next check-in.</span>
      ) : (
        <span class="status attention">
          The phone hasn't taken them yet{device.policyAskedAt !== null && <>; it last asked for rules {formatAgo(device.policyAskedAt, view.now)}</>}.
        </span>
      )}
    </p>
  );
};

export const ProtectionCard: FC<{ view: View; device: DeviceView; rules: Rules; undecidedApps: number; askAgain: AskAgain | null }> = ({
  view,
  device,
  rules,
  undecidedApps,
  askAgain,
}) =>
  rules.protectedAt === null ? (
    <div class="card">
      <p>
        <strong>Protection is off.</strong> Turning it on, in one step:
      </p>
      <ul>
        {askAgain ? (
          <li>
            New apps wait for your approval again. The {askAgain.installedMeanwhile.length} app{askAgain.installedMeanwhile.length === 1 ? "" : "s"} installed
            while new apps were allowed {askAgain.installedMeanwhile.length === 1 ? "is" : "are"} allowed
            {askAgain.waitingBefore.length > 0 && (
              <>
                , and the {askAgain.waitingBefore.length} that {askAgain.waitingBefore.length === 1 ? "was" : "were"} waiting for you before still{" "}
                {askAgain.waitingBefore.length === 1 ? "waits" : "wait"}
              </>
            )}
            . To choose app by app, switch new apps to Ask first.
          </li>
        ) : (
          <li>
            New apps wait for your approval. The {undecidedApps} app{undecidedApps === 1 ? "" : "s"} already on the phone{" "}
            {undecidedApps === 1 ? "is" : "are"} allowed, so nothing stops working by surprise.
          </li>
        )}
        <li>Locks safe mode, adding users, installing apps from outside the Play Store, VPN and Private DNS settings, date and time, and default apps.</li>
        <li>{rules.privateDns ? "Keeps the web filter you chose." : `Filters the web with ${DNS_FILTERS.cleanbrowsing.name}, for every app.`}</li>
        <li>
          {rules.chrome
            ? "Keeps the Chrome settings you chose."
            : "Chrome: SafeSearch, YouTube Restricted Mode (strict), adult sites filtered, no incognito tabs, no downloads."}
        </li>
      </ul>
      <p class="muted small">
        It doesn't lock accounts or the SIM, or factory reset and debugging: those are separate, below. You can change each piece afterwards.
      </p>
      <PostButton view={view} action={`/devices/${device.id}/protect`}>
        Turn protection on
      </PostButton>
    </div>
  ) : (
    <div class="card">
      <p>
        <strong>Protection is on</strong>, since <Time ms={rules.protectedAt} tz={view.tz} />. Change any piece of it below.
      </p>
      <p class="muted small">
        Turning it off lets new apps run without asking, unlocks every setting (factory reset and debugging too), and removes the web filter,
        Chrome's settings, a pause and maintenance mode. Apps you blocked stay blocked.
      </p>
      <PostButton
        view={view}
        action={`/devices/${device.id}/unprotect`}
        kind="danger"
        confirm={`Turn protection off on ${device.name}? New apps will run without asking, and nothing will be locked or filtered.`}
      >
        Turn protection off
      </PostButton>
    </div>
  );

export const PauseCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => {
  const pause = activePause(rules, view.now);
  return (
    <div class="card">
      {pause && (
        <>
          <p>
            <strong>Paused</strong> {pause.until === null ? "until you resume it" : <>until <Time ms={pause.until} tz={view.tz} /></>}.
          </p>
          {pause.note && (
            <>
              <p class="small muted">The note on the phone:</p>
              <blockquote>{pause.note}</blockquote>
            </>
          )}
          <p>
            <PostButton view={view} action={`/devices/${device.id}/resume`}>
              Resume now
            </PostButton>
          </p>
        </>
      )}
      <form class="stack" method="post" action={`/devices/${device.id}/pause`}>
        <Csrf view={view} />
        <p class="muted small">Every app but the phone app, texting and Belay stops until then. 911 and 988 always work.</p>
        <label for="pause-for">{pause ? "Pause for a different time" : "Pause the phone for"}</label>
        <select id="pause-for" name="minutes">
          {PAUSE_CHOICES.map(([value, label]) => (
            <option value={value} selected={value === "60"}>
              {label}
            </option>
          ))}
        </select>
        <label for="pause-note">A note shown on the phone (optional)</label>
        <input id="pause-note" type="text" name="note" maxlength={LIMITS.pauseNote} value={pause?.note ?? ""} placeholder="Dinner time" />
        <div>
          <button type="submit" class={pause ? "quiet" : undefined}>
            {pause ? "Change the pause" : "Pause the phone"}
          </button>
        </div>
      </form>
    </div>
  );
};

export const NewAppsCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => (
  <form class="stack card" method="post" action={`/devices/${device.id}/new-apps`}>
    <Csrf view={view} />
    <label class="check">
      <input type="radio" name="mode" value="ask" checked={rules.newApps === "ask"} /> Ask: each new app waits for my approval
    </label>
    <label class="check">
      <input type="radio" name="mode" value="allow" checked={rules.newApps === "allow"} /> Allow: new apps run without asking
    </label>
    <p class="muted small">
      With Ask, the phone suspends a new app the moment it installs, and the kid can ask you for it from Belay's screen. Android has no way to stop an
      install itself, so an app can run for a moment first.{" "}
      {rules.askFirstAt === null
        ? "The first time you switch to Ask, the apps already on the phone are allowed."
        : "Switching back to Ask, you choose which apps installed in between keep working."}
    </p>
    <div>
      <button type="submit" class="quiet">
        Save
      </button>
    </div>
  </form>
);

export const WebCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => {
  const known = Object.entries(DNS_FILTERS).find(([, f]) => f.host === rules.privateDns)?.[0];
  const filter = rules.privateDns === null ? "off" : (known ?? "custom");
  const chrome = rules.chrome ?? SAFE_CHROME;
  return (
    <form class="stack card" method="post" action={`/devices/${device.id}/web`}>
      <Csrf view={view} />
      <fieldset>
        <legend>
          <strong>Web filter</strong> (Private DNS, for every app)
        </legend>
        <label class="check">
          <input type="radio" name="filter" value="cleanbrowsing" checked={filter === "cleanbrowsing"} /> {DNS_FILTERS.cleanbrowsing.name}{" "}
          <span class="pkg">{DNS_FILTERS.cleanbrowsing.host}</span>
        </label>
        <label class="check">
          <input type="radio" name="filter" value="adguard" checked={filter === "adguard"} /> {DNS_FILTERS.adguard.name}{" "}
          <span class="pkg">{DNS_FILTERS.adguard.host}</span>
        </label>
        <label class="check">
          <input type="radio" name="filter" value="custom" checked={filter === "custom"} /> Another Private DNS host
        </label>
        <input
          type="text"
          name="custom_host"
          aria-label="Private DNS host"
          value={filter === "custom" ? (rules.privateDns ?? "") : ""}
          placeholder="dns.example.org"
          maxlength={253}
          inputmode="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <label class="check">
          <input type="radio" name="filter" value="off" checked={filter === "off"} /> Off
        </label>
        <p class="muted small">Lock Private DNS settings (below) so the filter can't be turned off on the phone.</p>
        <p class="muted small">
          Belay on the phone reports when Private DNS isn't working. It does while the phone is offline, and while another user or profile is on
          the phone, so one report now and then doesn't mean the filter is broken. One that stays while the phone is online is worth a look.
        </p>
      </fieldset>
      <fieldset>
        <legend>
          <strong>Chrome</strong>
        </legend>
        <label class="check">
          <input type="checkbox" name="chrome" value="1" checked={rules.chrome !== null} /> Manage Chrome's settings
        </label>
        <label class="check">
          <input type="checkbox" name="safe_search" value="1" checked={chrome.safe_search} /> SafeSearch on Google
        </label>
        <label class="check">
          <input type="checkbox" name="safe_sites" value="1" checked={chrome.safe_sites} /> Filter adult sites (Google SafeSites)
        </label>
        <label class="check">
          <input type="checkbox" name="incognito" value="1" checked={chrome.incognito} /> Allow incognito tabs
        </label>
        <label class="check">
          <input type="checkbox" name="allow_downloads" value="1" checked={chrome.allow_downloads} /> Allow downloads
        </label>
        <label for="youtube">YouTube Restricted Mode</label>
        <select id="youtube" name="youtube">
          {(["strict", "moderate", "off"] as const).map((v) => (
            <option value={v} selected={chrome.youtube_restrict === v}>
              {v === "off" ? "Off" : v === "strict" ? "Strict" : "Moderate"}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" name="allowlist_mode" value="1" checked={chrome.url_allowlist !== null} /> Only open the sites listed here
        </label>
        <textarea name="allowlist" aria-label="Sites Chrome may open, one per line" placeholder="example.org" autocapitalize="off" autocorrect="off" spellcheck={false}>
          {(chrome.url_allowlist ?? []).join("\n")}
        </textarea>
        <label for="blocklist">Block these sites, one per line</label>
        <textarea id="blocklist" name="blocklist" placeholder="example.com" autocapitalize="off" autocorrect="off" spellcheck={false}>
          {chrome.url_blocklist.join("\n")}
        </textarea>
      </fieldset>
      <label class="check">
        <input type="checkbox" name="hide_browsers" value="1" checked={rules.hideBrowsers} /> No browser: hide every browser on the phone
      </label>
      <div>
        <button type="submit">Save</button>
      </div>
    </form>
  );
};

export const RestrictionsCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => (
  <form class="stack card" method="post" action={`/devices/${device.id}/restrictions`}>
    <Csrf view={view} />
    <fieldset>
      <legend>
        <strong>Locked on the phone</strong> (none of these can lock anyone out)
      </legend>
      {SAFE_RESTRICTIONS.map((r) => (
        <label class="check">
          <input type="checkbox" name="lock" value={r} checked={rules.restrictions[r]} /> {RESTRICTION_NAMES[r]}
        </label>
      ))}
    </fieldset>
    <fieldset>
      <legend>
        <strong>Accounts and SIM</strong>
      </legend>
      <label class="check">
        <input type="checkbox" name="lock" value="modify_accounts" checked={rules.restrictions.modify_accounts} /> {RESTRICTION_NAMES.modify_accounts}
      </label>
      {!rules.restrictions.modify_accounts && (
        <>
          <p class="muted small">Add the parent-owned Google account first: once this is locked, no account can be added or removed, including the one Play needs.</p>
          <label class="check">
            <input type="checkbox" name="accounts_ready" value="1" /> The parent-owned Google account is already on the phone
          </label>
        </>
      )}
      <label class="check">
        <input type="checkbox" name="lock" value="sim" checked={rules.restrictions.sim} /> {RESTRICTION_NAMES.sim}
      </label>
      <p class="muted small">
        This stops anyone adding or downloading an eSIM. It doesn't stop someone swapping in a different physical SIM card; Belay on the phone
        reports a SIM change if it notices one.
      </p>
      {!rules.restrictions.sim && (
        <>
          <p class="muted small">Activate the phone's line first: once this is locked, no eSIM can be added, including the phone's own.</p>
          <label class="check">
            <input type="checkbox" name="sim_ready" value="1" /> The phone's line is activated and working
          </label>
        </>
      )}
    </fieldset>
    <div>
      <button type="submit">Save</button>
    </div>
  </form>
);

export const SupportCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => (
  <form class="stack card" method="post" action={`/devices/${device.id}/support`}>
    <Csrf view={view} />
    <label for="support-message">Your words on blocked-app screens (optional)</label>
    <input id="support-message" type="text" name="message" maxlength={LIMITS.supportMessage} value={rules.supportMessage ?? ""} placeholder="Ask Mom or Dad" />
    <div>
      <button type="submit" class="quiet">
        Save
      </button>
    </div>
  </form>
);

export const MaintenanceCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => {
  const until = activeMaintenance(rules, view.now);
  return (
    <div class="card">
      {until !== null && (
        <>
          <p>
            <strong>Maintenance mode is on</strong> until <Time ms={until} tz={view.tz} />: USB debugging works, for repairs over adb.
          </p>
          <p>
            <PostButton view={view} action={`/devices/${device.id}/maintenance`} fields={{ end: "1" }} kind="quiet">
              End it now
            </PostButton>
          </p>
        </>
      )}
      {rules.restrictions.debugging ? (
        <form class="row" method="post" action={`/devices/${device.id}/maintenance`}>
          <Csrf view={view} />
          <span>Lift the debugging lock for</span>
          {[...MAINTENANCE_HOURS].map((h) => (
            <button type="submit" name="hours" value={h} class="quiet">
              {h === "1" ? "1 hour" : `${h} hours`}
            </button>
          ))}
        </form>
      ) : (
        <p class="muted">Debugging isn't locked, so adb works already. Maintenance mode is for when it is.</p>
      )}
    </div>
  );
};

/** Factory reset, debugging and reset protection: off by default, behind a warning and the phone's name. */
export const HardeningCard: FC<{ view: View; device: DeviceView; rules: Rules }> = ({ view, device, rules }) => (
  <div class="card danger-zone">
    <p>
      <strong>These can lock the phone for good.</strong> With factory reset locked, nobody can reset the phone from Settings. With debugging
      locked, a computer can't repair it over USB (maintenance mode lifts that for a while). With reset protection, a phone reset from recovery mode
      only sets up again with one of the Google accounts listed here. If Belay or the phone breaks, it may not be fixable. Turn them on when the phone
      has worked well for a while and you're sure of the account.
    </p>
    <p class="muted small">
      None of these stops the kid opening Settings. Android's own Parental Controls, in Settings, can add a hidden profile that gets around the lock
      on adding users, and can lift Belay's suspensions. When Belay on the phone notices that, it shows at the top of this page.
    </p>
    {device.facts?.health.test_only && <Notice kind="warn">This is a debug build: Belay won't apply these.</Notice>}
    {rules.frpAccounts.length > 0 && !rules.restrictions.debugging && (
      <Notice kind="warn">Reset protection doesn't apply while OEM unlocking is on. Lock debugging too: that keeps OEM unlocking off.</Notice>
    )}
    <form class="stack" method="post" action={`/devices/${device.id}/hardening`}>
      <Csrf view={view} />
      <label class="check">
        <input type="checkbox" name="factory_reset" value="1" checked={rules.restrictions.factory_reset} /> Lock factory reset
      </label>
      <label class="check">
        <input type="checkbox" name="debugging" value="1" checked={rules.restrictions.debugging} /> Lock developer options and USB debugging
      </label>
      <label for="frp">Reset protection: the parent-owned Google account ids, one per line</label>
      <textarea id="frp" name="frp_accounts" placeholder="112233445566778899000" autocapitalize="off" autocorrect="off" spellcheck={false}>
        {rules.frpAccounts.join("\n")}
      </textarea>
      <details>
        <summary>How to find a Google account id</summary>
        <ol class="steps">
          <li>On a computer, sign in to Google with the parent-owned account, the one on the phone.</li>
          <li>
            Open Google's page for the People API's people.get method,{" "}
            <a href="https://developers.google.com/people/api/rest/v1/people/get" rel="noreferrer noopener" target="_blank">
              developers.google.com/people/api/rest/v1/people/get
            </a>
            , and find its "Try it!" panel.
          </li>
          <li>
            Set <strong>resourceName</strong> to <code>people/me</code> and <strong>personFields</strong> to <code>names</code>. Choose Execute, and
            let it use that account.
          </li>
          <li>
            The answer starts with <code>"resourceName": "people/</code> and a long number. That number is the account's id.
          </li>
        </ol>
        <p class="muted small">You do this in your own browser: Belay's server never contacts Google. A new account can take up to 72 hours before reset protection accepts it.</p>
        <p class="muted small">
          Reset protection doesn't apply while OEM unlocking is on (in Developer options). Locking debugging keeps OEM unlocking off, so turn both
          on together.
        </p>
      </details>
      <label for="play">Play Store: the parent-owned Google accounts Play may use, by email address, one per line</label>
      <textarea id="play" name="play_accounts" placeholder="parent@gmail.com" autocapitalize="off" autocorrect="off" spellcheck={false}>
        {rules.playAccounts.join("\n")}
      </textarea>
      <p class="muted small">
        With these, Play works only with these accounts, even if someone adds another account to the phone; leave it empty and Belay leaves Play's
        settings alone. It needs Google Play version 80970100 or newer. It can't lock anyone out of the phone, so it needs no name typed. Handing
        the phone over clears it, so the kid can use their own account.
      </p>
      <label for="confirm">
        To turn any of these on, type the phone's name: <strong>{device.name}</strong>
      </label>
      <input id="confirm" type="text" name="confirm" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck={false} inputmode="text" maxlength={60} />
      <div>
        <button type="submit" class="danger">
          Save
        </button>
      </div>
    </form>
  </div>
);

/**
 * Switching new apps back to Ask: the apps installed while new apps were allowed (ticked: they've
 * been running) and the ones that were waiting before (not ticked), for the parent to choose.
 */
export const AskAgainPage: FC<{ view: View; device: DeviceView; again: AskAgain }> = ({ view, device, again }) => (
  <Layout view={view} title={`New apps on ${device.name}`}>
    <p class="small">
      <a href={`/devices/${device.id}#new-apps`}>← {device.name}</a>
    </p>
    <h1>Ask about new apps again?</h1>
    <p>From now on, each new app waits for your approval. Choose which of the apps without a decision keep working; the others wait for you.</p>
    <form class="stack card" method="post" action={`/devices/${device.id}/new-apps`}>
      <Csrf view={view} />
      <input type="hidden" name="mode" value="ask" />
      <input type="hidden" name="confirm" value="1" />
      {again.installedMeanwhile.length > 0 && (
        <fieldset>
          <legend>
            <strong>Installed while new apps were allowed</strong>
            {again.since !== null && (
              <>
                {" "}
                (since <Time ms={again.since} tz={view.tz} />)
              </>
            )}
          </legend>
          <p class="muted small">They've been running. The ticked ones are allowed.</p>
          {again.installedMeanwhile.map((a) => (
            <label class="check">
              <input type="checkbox" name="allow" value={a.package} checked /> {a.label} <span class="pkg">{a.package}</span>
            </label>
          ))}
        </fieldset>
      )}
      {again.waitingBefore.length > 0 && (
        <fieldset>
          <legend>
            <strong>Waiting for you from before</strong>
          </legend>
          <p class="muted small">These were waiting for your approval before new apps were allowed. They wait again unless you tick them.</p>
          {again.waitingBefore.map((a) => (
            <label class="check">
              <input type="checkbox" name="allow" value={a.package} /> {a.label} <span class="pkg">{a.package}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div class="row">
        <button type="submit">Switch to Ask</button>
        <a href={`/devices/${device.id}#new-apps`}>Cancel</a>
      </div>
    </form>
  </Layout>
);

/** Who made an app's decision, in words. */
export function decidedByWords(d: Decision): string {
  switch (d.decidedBy) {
    case "grandfathered":
      return "on the phone when new apps started needing approval";
    case "ai":
      return `by ${d.clientName ?? "an AI app"}, through ${d.parentName ?? "a parent"}'s connection`;
    case "server":
      return "by the server's admin command";
    case "parent":
      return `by ${d.parentName ?? "a former parent account"}${d.proposalId ? ` (an AI app's proposal)` : ""}`;
  }
}

/** The kid's request in an app list: their words, labeled, and the answer buttons (for a form elsewhere on the page). */
export const RequestAnswer: FC<{ view: View; request: RequestView }> = ({ view, request }) => {
  const form = `answer-${request.id}`;
  return (
    <div class="request">
      <p class="small">
        Asked <Time ms={Math.min(request.askedAt, request.receivedAt)} tz={view.tz} />
        {request.status === "talk" && " · you said let's talk"}. <span class="muted">In their words:</span>
      </p>
      {request.reason ? <blockquote class="kid">{request.reason}</blockquote> : <p class="muted small">They didn't say why.</p>}
      <label for={`note-${request.id}`} class="small">
        Your answer, shown on the phone (optional)
      </label>
      <textarea id={`note-${request.id}`} form={form} name="note" maxlength={LIMITS.answerNote}>
        {request.note ?? ""}
      </textarea>
      <div class="row">
        <button type="submit" form={form} name="answer" value="approved">
          Approve<span class="sr-only"> {request.label}</span>
        </button>
        <button type="submit" form={form} name="answer" value="talk" class="quiet">
          Let's talk<span class="sr-only"> about {request.label}</span>
        </button>
        <button type="submit" form={form} name="answer" value="declined" class="quiet">
          Decline<span class="sr-only"> {request.label}</span>
        </button>
      </div>
    </div>
  );
};
