package family.brooker.belay.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import family.brooker.belay.DebugTools
import family.brooker.belay.R
import family.brooker.belay.core.EnrollProblem
import family.brooker.belay.core.Enrollment
import family.brooker.belay.enroll.EnrollFlow

/**
 * Connect to a Belay server: scan its QR code, or type its address and the code.
 * [onOpenCamera] lifts Belay's own camera policy before scanning (false if it couldn't).
 */
@Composable
fun EnrollScreen(
    state: EnrollFlow.State,
    alreadyConnected: Boolean,
    deviceOwner: Boolean,
    onOpenCamera: () -> Boolean,
    onConnect: (server: String, code: String) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var scanning by rememberSaveable { mutableStateOf(false) }
    var cameraMessage by rememberSaveable { mutableStateOf<Int?>(null) }
    var server by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var formProblem by rememberSaveable { mutableStateOf<EnrollProblem?>(null) }
    val askForCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        scanning = granted
        cameraMessage = if (granted) null else R.string.enroll_camera_denied
    }

    fun startScanning() {
        cameraMessage = null
        when {
            !onOpenCamera() -> cameraMessage = R.string.enroll_camera_denied
            hasCameraPermission(context) -> scanning = true
            else -> askForCamera.launch(Manifest.permission.CAMERA)
        }
    }

    fun connect() {
        formProblem = when {
            Enrollment.normalizeServer(server, DebugTools.CLEARTEXT_HOSTS) == null -> EnrollProblem.BAD_SERVER
            Enrollment.normalizeCode(code) == null -> EnrollProblem.BAD_CODE
            else -> null
        }
        if (formProblem == null) {
            scanning = false
            onConnect(server, code)
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.enroll_title), style = MaterialTheme.typography.headlineSmall)
            when {
                state is EnrollFlow.State.Done -> {
                    Text(stringResource(R.string.enroll_done_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.enroll_done_text, state.host, state.deviceName), style = MaterialTheme.typography.bodyLarge)
                    Button(onClick = onClose) { Text(stringResource(R.string.enroll_done)) }
                }
                alreadyConnected -> {
                    Text(problemText(EnrollProblem.ALREADY_CONNECTED), style = MaterialTheme.typography.bodyLarge)
                    OutlinedButton(onClick = onClose) { Text(stringResource(R.string.enroll_back)) }
                }
                state is EnrollFlow.State.Working -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        CircularProgressIndicator()
                        Text(stringResource(R.string.enroll_connecting, state.host), style = MaterialTheme.typography.bodyLarge)
                    }
                }
                else -> {
                    Text(stringResource(R.string.enroll_intro), style = MaterialTheme.typography.bodyLarge)
                    if (state is EnrollFlow.State.Failed) {
                        Text(problemText(state.problem), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge)
                    }
                    if (scanning) {
                        QrScanner(
                            onText = { text ->
                                val target = Enrollment.parseLink(text, DebugTools.CLEARTEXT_HOSTS)
                                if (target == null) {
                                    cameraMessage = R.string.enroll_not_belay_qr
                                } else {
                                    scanning = false
                                    onConnect(target.server, target.code)
                                }
                            },
                            onUnavailable = {
                                scanning = false
                                cameraMessage = R.string.enroll_no_camera
                            },
                            modifier = Modifier.fillMaxWidth().aspectRatio(3f / 4f),
                        )
                        Text(stringResource(R.string.enroll_scan_hint), style = MaterialTheme.typography.bodyMedium)
                        OutlinedButton(onClick = { scanning = false }) { Text(stringResource(R.string.enroll_scan_stop)) }
                    } else {
                        Button(onClick = ::startScanning) { Text(stringResource(R.string.enroll_scan)) }
                    }
                    cameraMessage?.let { Text(stringResource(it), style = MaterialTheme.typography.bodyMedium) }
                    Text(stringResource(R.string.enroll_camera_note), style = MaterialTheme.typography.bodySmall)
                    if (deviceOwner) Text(stringResource(R.string.enroll_camera_locked_after), style = MaterialTheme.typography.bodySmall)

                    Text(stringResource(R.string.enroll_or_type), style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        value = server,
                        onValueChange = { server = it },
                        label = { Text(stringResource(R.string.enroll_server_label)) },
                        placeholder = { Text(stringResource(R.string.enroll_server_hint)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Next,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it },
                        label = { Text(stringResource(R.string.enroll_code_label)) },
                        placeholder = { Text(stringResource(R.string.enroll_code_hint)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = { connect() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    formProblem?.let { Text(problemText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(onClick = ::connect) { Text(stringResource(R.string.enroll_connect)) }
                }
            }
        }
    }
}

@Composable
private fun problemText(problem: EnrollProblem): String = stringResource(
    when (problem) {
        EnrollProblem.BAD_SERVER -> R.string.enroll_problem_bad_server
        EnrollProblem.BAD_CODE -> R.string.enroll_problem_bad_code
        EnrollProblem.CODE_REFUSED -> R.string.enroll_problem_code_refused
        EnrollProblem.RATE_LIMITED -> R.string.enroll_problem_rate_limited
        EnrollProblem.UNREACHABLE -> R.string.enroll_problem_unreachable
        EnrollProblem.NOT_BELAY -> R.string.enroll_problem_not_belay
        EnrollProblem.REFUSED -> R.string.enroll_problem_refused
        EnrollProblem.SERVER_ERROR -> R.string.enroll_problem_server_error
        EnrollProblem.ALREADY_CONNECTED -> R.string.enroll_problem_already_connected
        EnrollProblem.PHONE_ERROR -> R.string.enroll_problem_phone_error
    },
)
