package family.brooker.belay.provisioning

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import family.brooker.belay.Agent
import family.brooker.belay.DeviceOwnerSetup
import family.brooker.belay.Trigger

/**
 * Android 12+ managed provisioning (QR code, NFC, zero-touch) asks the DPC which mode it
 * wants. Belay only manages a whole phone: fully managed, or nothing. (Belay itself is
 * provisioned with adb; see docs/platform-notes.md on QR provisioning and Play Protect.)
 */
class GetProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val allowed = intent.getIntegerArrayListExtra(DevicePolicyManager.EXTRA_PROVISIONING_ALLOWED_PROVISIONING_MODES)
        val fullyManaged = DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
        if (allowed.isNullOrEmpty() || fullyManaged in allowed) {
            setResult(RESULT_OK, Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, fullyManaged))
        } else {
            // A personally owned phone offering only a work profile: not something Belay does.
            setResult(RESULT_CANCELED)
        }
        finish()
    }
}

/**
 * The last step of managed provisioning (ADMIN_POLICY_COMPLIANCE), and the
 * PROVISIONING_SUCCESSFUL notice that can follow it. Both apply the same idempotent setup.
 */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceOwnerSetup.ensure(this)
        Agent.handle(this, Trigger.PROVISIONED)
        setResult(RESULT_OK)
        finish()
    }
}
