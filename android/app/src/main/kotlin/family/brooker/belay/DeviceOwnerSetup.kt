package family.brooker.belay

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.util.Log
import family.brooker.belay.core.CategoryPermissions
import family.brooker.belay.enroll.CameraGate
import family.brooker.belay.inventory.packageInfoCompat
import family.brooker.belay.store.AgentStore

/**
 * What Belay does to the phone once it is device owner. Phase 0 and Phase 1 restrict
 * nothing else: no user restrictions, no app suspension, no network settings.
 */
object DeviceOwnerSetup {
    /**
     * Runtime permissions Belay never grants itself. CAMERA is only for scanning the
     * enrollment QR code, and only if the person scanning allows it (see [CameraGate]).
     */
    val NEVER_GRANTED: Set<String> = CategoryPermissions.NEVER_GRANTED

    fun admin(context: Context) = ComponentName(context, AdminReceiver::class.java)

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(DevicePolicyManager::class.java)

    fun isDeviceOwner(context: Context): Boolean = dpm(context).isDeviceOwnerApp(context.packageName)

    /**
     * Applies the setup, and is safe to run any number of times: after provisioning, at
     * every boot and service start, so anything lost comes back. Returns problems, if any.
     *
     * - Belay can't be uninstalled (setUninstallBlocked on itself).
     * - Belay's runtime permissions are granted by policy, so they can't be revoked in
     *   Settings: POST_NOTIFICATIONS keeps the managed notice visible.
     * - Phase 4: except those tied to a data category (location), granted only while the
     *   policy turns that category on (core's CategoryPermissions), and denied by policy
     *   otherwise, so Settings shows Belay without them and the kid can't grant them.
     * - Except CAMERA: denied by policy whenever the enrollment screen isn't scanning, so
     *   Belay can't use the camera, and Settings shows that.
     * - Debug builds only: a permission only a debug test holds (DebugTools.TESTED_PERMISSIONS:
     *   READ_SMS, for Phase 5's archival test), like a tied one: granted by policy while its test is
     *   on, denied by policy otherwise. Release builds have none.
     *
     * Denying a permission Belay holds makes Android stop and restart Belay's processes
     * (platform notes R5 and L7), so a tied permission still granted is left to [revokeUnwanted],
     * which the agent step calls once its own work is stored.
     */
    fun ensure(context: Context): List<String> {
        val dpm = dpm(context)
        val admin = admin(context)
        val pkg = context.packageName
        if (!dpm.isDeviceOwnerApp(pkg)) return listOf("not device owner")
        val problems = mutableListOf<String>()
        try {
            if (!dpm.isUninstallBlocked(admin, pkg)) dpm.setUninstallBlocked(admin, pkg, true)
        } catch (e: RuntimeException) {
            problems += "uninstall block: ${e.message}"
        }
        val plan = permissionPlan(context)
        for (permission in plan.grant) {
            setGrantState(dpm, admin, pkg, permission, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED, problems)
        }
        for (permission in plan.deny) {
            if (held(permission) && granted(context, permission)) continue
            setGrantState(dpm, admin, pkg, permission, DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED, problems)
        }
        if (problems.isNotEmpty()) Log.w(Agent.TAG, "device-owner setup: $problems")
        return problems
    }

    /**
     * The permissions Belay should hold now: the stored policy's categories (the test policy on a
     * debug build), and the one fix a kid is sharing with a help request (core's LocationState.help);
     * on a debug build, those of a debug test that's on.
     */
    fun permissionPlan(context: Context): CategoryPermissions.Plan {
        val store = AgentStore.get(context)
        val policy = DebugTools.policyOverride ?: store.policy()
        val sharing = store.locationState()?.help != null
        val declared = declaredRuntimePermissions(context)
        val tested = declared.filter { it in DebugTools.TESTED_PERMISSIONS }
        val plan = CategoryPermissions.plan(declared - tested.toSet(), CategoryPermissions.categoriesOn(policy, sharing), CameraGate.inUse)
        if (tested.isEmpty()) return plan
        val testing = DebugTools.testing(context)
        return CategoryPermissions.Plan(plan.grant + tested.filter { it in testing }, tested.filterNot { it in testing } + plan.deny)
    }

    /**
     * Tied permissions Belay still holds but shouldn't with the categories [on] (location turned off,
     * lost mode or a help fix ended; Phase 5: calls turned off); on a debug build, a debug test's once
     * it's off.
     */
    fun unwanted(context: Context, on: Set<String>): List<String> {
        val testing = DebugTools.testing(context)
        return declaredRuntimePermissions(context).filter {
            val wanted = if (it in DebugTools.TESTED_PERMISSIONS) it in testing else CategoryPermissions.CATEGORY[it] in on
            held(it) && !wanted && granted(context, it)
        }
    }

    /**
     * Denies them now, as device owner. Android then stops Belay's processes and starts them again
     * (its service and DeviceAdminService come back by themselves; platform notes L7): the agent
     * step calls this last, after storing what it did. Returns problems, if any.
     */
    fun revokeUnwanted(context: Context): List<String> {
        val dpm = dpm(context)
        if (!dpm.isDeviceOwnerApp(context.packageName)) return emptyList()
        val problems = mutableListOf<String>()
        // Background location first: it only works with a foreground one (core's CategoryPermissions.plan).
        // Phase 5: the call permissions, once calls is off, the same way.
        val unwanted = permissionPlan(context).deny.filter { held(it) && granted(context, it) }
        if (unwanted.isEmpty()) return problems
        Log.i(Agent.TAG, "permissions: denying ${unwanted.map { it.substringAfterLast('.') }} by policy; Android restarts Belay")
        for (permission in unwanted) {
            setGrantState(dpm, admin(context), context.packageName, permission, DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED, problems)
        }
        return problems
    }

    private fun granted(context: Context, permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Held only at times: tied to a data category, or (debug builds) to a debug test. */
    private fun held(permission: String): Boolean = CategoryPermissions.tied(permission) || permission in DebugTools.TESTED_PERMISSIONS

    private fun setGrantState(
        dpm: DevicePolicyManager,
        admin: ComponentName,
        pkg: String,
        permission: String,
        wanted: Int,
        problems: MutableList<String>,
    ) {
        try {
            if (dpm.getPermissionGrantState(admin, pkg, permission) != wanted &&
                !dpm.setPermissionGrantState(admin, pkg, permission, wanted)
            ) {
                problems += "$permission: refused"
            }
        } catch (e: RuntimeException) {
            problems += "$permission: ${e.message}"
        }
    }

    /**
     * The runtime ("dangerous") permissions Belay declares in its manifest. Read once per process:
     * they only change with an update, which starts a new process.
     */
    fun declaredRuntimePermissions(context: Context): List<String> = declared ?: readDeclared(context).also { declared = it }

    @Volatile
    private var declared: List<String>? = null

    private fun readDeclared(context: Context): List<String> {
        val pm = context.packageManager
        val requested = pm.packageInfoCompat(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions.orEmpty()
        return requested.filter { name ->
            try {
                pm.getPermissionInfo(name, 0).protection == PermissionInfo.PROTECTION_DANGEROUS
            } catch (e: PackageManager.NameNotFoundException) {
                false
            }
        }
    }

    /** Whether Belay holds fine location now (granted by policy while location is on). */
    fun hasLocation(context: Context): Boolean = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
}
