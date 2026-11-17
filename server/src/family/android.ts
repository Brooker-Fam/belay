/**
 * What the server knows of Android's own words, to tell a phone's report from free text. A phone
 * token can send anything (a tampered agent, a stolen phone), so what the phone reports reaches
 * an AI client in plain fields only when it fits one of these exactly; anything else goes under
 * `untrusted` (CLAUDE.md, principle 3).
 */
import { isValidTimeZone } from "../time.js";

/**
 * Every permission Belay declares (android/app/src/main/AndroidManifest.xml). The phone reports
 * its runtime ones in health.permissions, by the last part of the name ("POST_NOTIFICATIONS").
 */
export const BELAY_PERMISSIONS: ReadonlySet<string> = new Set([
  "QUERY_ALL_PACKAGES",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_SYSTEM_EXEMPTED",
  "RECEIVE_BOOT_COMPLETED",
  "POST_NOTIFICATIONS",
  "PACKAGE_USAGE_STATS",
  "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "INTERNET",
  "ACCESS_LOCAL_NETWORK",
  "ACCESS_NETWORK_STATE",
  "CAMERA",
]);

/** A permission name as the phone reports it, without "android.permission.", if Belay declares it. */
export function belayPermission(name: string): string | null {
  const short = name.replace(/^android\.permission\./, "");
  return BELAY_PERMISSIONS.has(short) ? short : null;
}

/**
 * Every user restriction key Android declares: the DISALLOW_, ENSURE_ and ALLOW_ constants of
 * UserManager (core/java/android/os/UserManager.java, tag android-17.0.0_r1, hidden ones
 * included). The phone reports the ones in force that Belay didn't set (Phase 10).
 */
export const USER_RESTRICTIONS: ReadonlySet<string> = new Set([
  "allow_parent_profile_app_linking",
  "disallow_biometric",
  "disallow_camera_toggle",
  "disallow_config_default_apps",
  "disallow_config_private_dns",
  "disallow_microphone_toggle",
  "disallow_unmute_device",
  "ensure_verify_apps",
  "no_add_clone_profile",
  "no_add_guest",
  "no_add_managed_profile",
  "no_add_private_profile",
  "no_add_user",
  "no_add_wifi_config",
  "no_adjust_volume",
  "no_airplane_mode",
  "no_ambient_display",
  "no_assist_content",
  "no_autofill",
  "no_bluetooth",
  "no_bluetooth_sharing",
  "no_camera",
  "no_cellular_2g",
  "no_change_near_field_communication_radio",
  "no_change_wifi_state",
  "no_config_bluetooth",
  "no_config_brightness",
  "no_config_cell_broadcasts",
  "no_config_credentials",
  "no_config_date_time",
  "no_config_locale",
  "no_config_location",
  "no_config_mobile_networks",
  "no_config_screen_timeout",
  "no_config_tethering",
  "no_config_vpn",
  "no_config_wifi",
  "no_config_wifi_private",
  "no_config_wifi_shared",
  "no_content_capture",
  "no_content_suggestions",
  "no_control_apps",
  "no_create_windows",
  "no_cross_profile_copy_paste",
  "no_data_roaming",
  "no_debugging_features",
  "no_factory_reset",
  "no_fun",
  "no_grant_admin",
  "no_install_apps",
  "no_install_unknown_sources",
  "no_install_unknown_sources_globally",
  "no_modify_accounts",
  "no_near_field_communication_radio",
  "no_network_reset",
  "no_non_tool_accessibility_service",
  "no_oem_unlock",
  "no_outgoing_beam",
  "no_outgoing_calls",
  "no_physical_media",
  "no_printing",
  "no_record_audio",
  "no_remove_managed_profile",
  "no_remove_user",
  "no_run_in_background",
  "no_safe_boot",
  "no_set_user_icon",
  "no_set_wallpaper",
  "no_share_location",
  "no_sharing_admin_configured_wifi",
  "no_sharing_into_profile",
  "no_sim_globally",
  "no_sms",
  "no_system_error_dialogs",
  "no_task_continuity_handoff",
  "no_thread_network",
  "no_ultra_wideband_radio",
  "no_unified_password",
  "no_uninstall_apps",
  "no_unmute_microphone",
  "no_usb_file_transfer",
  "no_user_switch",
  "no_wallpaper",
  "no_wifi_direct",
  "no_wifi_tethering",
]);

/** Words for the restrictions most likely to show up, set by Android's own Parental Controls or another admin. */
export const RESTRICTION_WORDS: Readonly<Record<string, string>> = {
  no_factory_reset: "factory reset",
  no_debugging_features: "developer options and USB debugging",
  no_add_user: "adding users",
  no_remove_user: "removing users",
  no_install_apps: "installing apps",
  no_uninstall_apps: "uninstalling apps",
  no_install_unknown_sources: "installing apps from unknown sources",
  no_install_unknown_sources_globally: "installing apps from outside the Play Store",
  no_modify_accounts: "adding or removing accounts",
  no_config_date_time: "changing the date and time",
  no_config_private_dns: "changing Private DNS",
  disallow_config_private_dns: "changing Private DNS",
  no_safe_boot: "safe mode",
  no_config_vpn: "changing VPN settings",
  no_outgoing_calls: "making calls",
  no_sms: "texting",
  no_camera: "the camera",
  no_share_location: "sharing location",
  no_control_apps: "stopping apps or clearing their data",
  no_user_switch: "switching users",
};

/** "17", "16.1": Android's release name. */
export const validRelease = (value: string): boolean => /^\d{1,3}(\.\d{1,3}){0,2}$/.test(value);
/** "37.2": the SDK version, with its minor version. */
export const validSdkFull = (value: string): boolean => /^\d{1,3}(\.\d{1,3}){0,2}$/.test(value);
/** "2026-11-05": the security patch level. */
export const validPatch = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** "0.2.0-phase2": Belay's version name, as its build sets it. */
export const validVersionName = (value: string): boolean => /^\d{1,4}(\.\d{1,4}){0,3}(-[0-9A-Za-z]{1,20})?$/.test(value);
/** "America/New_York": a real IANA zone, nothing else. */
export const validZone = (value: string): boolean => /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) && isValidTimeZone(value);
