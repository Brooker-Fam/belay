package family.brooker.belay.fixture;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * A blank screen with a launcher icon (Phase 3), so tests can open the fixture app, count its
 * time on the screen, and see a schedule or a time limit pause it. For Phase 3's network logging,
 * opened with the extra "lookup" (a made-up host name), it looks that name up once, so a test has
 * a DNS lookup by an app Belay may note:
 *
 *     adb shell am start -n family.brooker.belay.fixture/.FixtureActivity --es lookup example.com
 *
 * Several names, comma separated, are looked up one after the other, in that order, so Android
 * logs them in that order ("ci-private.example.org,ci-lookup.example.com": a batch with the
 * second has the first, or follows one that does). It does nothing else.
 */
public class FixtureActivity extends Activity {
    static final String EXTRA_LOOKUP = "lookup";
    private static final String TAG = "BelayFixture";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lookUp(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        lookUp(intent);
    }

    /** Off the main thread: Android looks names up over the network. One thread, so in order. */
    private static void lookUp(Intent intent) {
        String names = intent == null ? null : intent.getStringExtra(EXTRA_LOOKUP);
        if (names == null || names.isEmpty()) return;
        new Thread(() -> {
            for (String host : names.split(",")) {
                if (host.isEmpty()) continue;
                try {
                    Log.i(TAG, "looked up " + host + ": " + InetAddress.getAllByName(host).length + " addresses");
                } catch (UnknownHostException e) {
                    // Looked up all the same: Android logs a lookup, answer or not.
                    Log.i(TAG, "looked up " + host + ": no answer");
                }
            }
        }, "fixture-lookup").start();
    }
}
