# The Pixel 8

Belay targets a used Pixel 8 on Android 17. Google supports the Pixel 8 with updates
until October 2030.

## Buying a used one

- **The seller must remove their Google account** before handing it over, and ideally
  factory reset it in front of you. Otherwise factory reset protection asks for their
  account after any reset, and the phone is useless.
- **Not carrier-locked and not finance-locked.** A phone still being paid off can be
  locked by the carrier or lender later. Check the IMEI with the carrier, and ask whether
  it was bought outright. On a Pixel, Settings > System > Developer options > "OEM
  unlocking" greyed out usually means a carrier lock (Belay doesn't need it unlocked;
  Phase 2 keeps it off).
- It boots, updates to the current Android 17, and the battery holds a charge.

## The phone line (Spectrum Mobile)

Activate the line (SIM or eSIM) **before Phase 2**: Phase 2 blocks SIM and eSIM changes.
When you factory reset, keep the eSIM: don't tick the option to erase eSIMs.

## Setting it up

1. Factory reset: Settings > System > Reset options > Erase all data.
2. Setup wizard: Wi-Fi, **skip the Google account**, screen lock as you like.
3. USB debugging on (Settings > About phone > tap Build number 7 times; Settings > System >
   Developer options > USB debugging).
4. On the parent page, Add a phone: name it and make an enrollment code (it works once,
   for 30 minutes).
5. `android/scripts/build-release.sh`, then
   `android/scripts/provision.sh --server https://belay.example.org --code <code>`
   ([phase0-checklist.md](phase0-checklist.md) step 1 walks through provisioning). The
   phone must be online at the end, when it connects to the server. Without `--server`,
   connect it later from Belay's own screen: scan the QR code on the Add a phone page, or
   type the server and the code.
6. **Add the parent-owned Google account** for the Play Store: Settings > Passwords &
   accounts > Add account > Google.
7. Check the parent page: the phone shows as OK, with its apps listed as new to review.

### Which Google account

Create a separate Google account that you, the parent, own, only for this phone:

- **Not your main account:** its mail, photos, contacts and passwords would be on the
  kid's phone.
- **Not a child (Family Link) account:** supervision very likely can't run next to a
  device owner ([platform-notes.md A1](platform-notes.md#a1-family-link-child-account-next-to-a-device-owner)).
  Belay does the supervising.

Phase 2 locks the phone to this account and turns on the Play Store's own parental
controls with a PIN.

## Returning the phone to normal

- **Release build:** factory reset from Settings (Settings > System > Reset options > Erase
  all data). That's the only way: Android has no other way to remove a release device
  owner. From Phase 2 on, Belay blocks factory reset, so lift that first from the parent
  page (Phase 2 maintenance mode).
- **Debug build:** `android/scripts/unprovision.sh`, no reset needed.
- **Reset from Settings, not from recovery mode,** while the parent account is on the
  phone: a recovery reset triggers factory reset protection and asks for that account.
