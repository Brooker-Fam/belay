import type { FC } from "hono/jsx";
import { PASSWORD_MIN } from "../../auth/parents.js";
import { timeZones } from "../../time.js";
import { Csrf, Layout, Notice, type View } from "../ui.js";

const PasswordFields: FC<{ label?: string }> = ({ label = "Password" }) => (
  <>
    <label for="password">{label}</label>
    <input id="password" type="password" name="password" autocomplete="new-password" minlength={PASSWORD_MIN} maxlength={256} required />
    <p class="muted small">At least {PASSWORD_MIN} characters. A few unrelated words together works well.</p>
    <label for="repeat">The same password again</label>
    <input id="repeat" type="password" name="repeat" autocomplete="new-password" required />
  </>
);

export const SetupPage: FC<{ view: View; token: string; error?: string; values?: Record<string, string> }> = ({ view, token, error, values = {} }) => (
  <Layout view={view} title="Set up Belay" narrow>
    <h1>Set up Belay</h1>
    <p>Create the first parent account. You can add a second parent later, in Settings.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack" method="post" action="/setup">
      <input type="hidden" name="token" value={token} />
      <label for="name">Your name</label>
      <input id="name" type="text" name="name" maxlength={60} required value={values.name} placeholder="Sam" />
      <label for="username">Username, for signing in</label>
      <input id="username" type="text" name="username" autocomplete="username" maxlength={64} required value={values.username} />
      <PasswordFields />
      <label for="timezone">Your family's timezone</label>
      <input id="timezone" type="text" name="timezone" list="zones" required value={values.timezone ?? "UTC"} data-browser-timezone />
      <datalist id="zones">
        {timeZones().map((tz) => (
          <option value={tz} />
        ))}
      </datalist>
      <button type="submit">Create account</button>
    </form>
  </Layout>
);

export const LoginPage: FC<{ view: View; error?: string; username?: string; next?: string }> = ({ view, error, username, next }) => (
  <Layout view={view} title="Sign in" narrow>
    <h1>Sign in to Belay</h1>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack" method="post" action="/login">
      <input type="hidden" name="next" value={next ?? "/"} />
      <label for="username">Username</label>
      <input id="username" type="text" name="username" autocomplete="username" required value={username} />
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    <p class="muted small">Forgot your password? Whoever runs the server can reset it (see docs/server.md).</p>
  </Layout>
);

export const InvitePage: FC<{ view: View; token: string; error?: string; values?: Record<string, string> }> = ({ view, token, error, values = {} }) => (
  <Layout view={view} title="Join Belay" narrow>
    <h1>Join your family's Belay</h1>
    <p>Another parent invited you. Create your account to see and manage the family's phones.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack" method="post" action={`/invite/${token}`}>
      <label for="name">Your name</label>
      <input id="name" type="text" name="name" maxlength={60} required value={values.name} />
      <label for="username">Username, for signing in</label>
      <input id="username" type="text" name="username" autocomplete="username" maxlength={64} required value={values.username} />
      <PasswordFields />
      <button type="submit">Create account</button>
    </form>
  </Layout>
);

export const MessagePage: FC<{ view: View; title: string; message: string; link?: { href: string; label: string } }> = ({ view, title, message, link }) => (
  <Layout view={view} title={title} narrow={view.parentName === null}>
    <h1>{title}</h1>
    <p>{message}</p>
    {link && (
      <p>
        <a href={link.href}>{link.label}</a>
      </p>
    )}
  </Layout>
);

export const ChangePasswordForm: FC<{ view: View }> = ({ view }) => (
  <form class="stack" method="post" action="/settings/password">
    <Csrf view={view} />
    <label for="current">Current password</label>
    <input id="current" type="password" name="current" autocomplete="current-password" required />
    <PasswordFields label="New password" />
    <button type="submit">Change password</button>
  </form>
);
