package family.brooker.belay.ui

import android.content.Context
import android.content.Intent

/** Belay's screens (Phase 7). Home opens from the managed notice; each other screen has Back. */
enum class Screen { HOME, REQUESTS, STAGE, RULES, CAN_SEE, TOLD, HELP, ABOUT }

object Screens {
    /** The screen a notice opens ("I need help" opens Help; a location check, What Belay told your parent). */
    const val EXTRA_SCREEN = "family.brooker.belay.extra.SCREEN"

    /** Opens Belay on [screen]: for Belay's own notices. */
    fun open(context: Context, screen: Screen): Intent = Intent(context, MainActivity::class.java)
        .putExtra(EXTRA_SCREEN, screen.name)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** The screen [intent] asks for, if any. */
    fun of(intent: Intent?): Screen? = named(intent?.getStringExtra(EXTRA_SCREEN))

    fun named(name: String?): Screen? = Screen.entries.firstOrNull { it.name == name }
}
