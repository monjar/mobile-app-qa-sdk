/*
 * Entry point of the optional system-capture module, created by the Snitch
 * core via Class.forName("io.github.monjar.snitch.system.SystemCapture") when
 * the effective capture mode is `system` (spec §5.3). The core never links
 * against this module, so it must keep a public no-arg constructor (see
 * consumer-rules.pro).
 *
 * start() launches SystemCaptureActivity for the MediaProjection consent;
 * the projection itself lives in SnitchProjectionService. The FrameSink is
 * handed over through a process-wide holder because activities and services
 * can't receive objects through intents.
 */
package io.github.monjar.snitch.system

import android.app.Activity
import android.content.Context
import android.content.Intent
import io.github.monjar.snitch.capture.FrameSink
import io.github.monjar.snitch.capture.SystemCaptureModule

class SystemCapture : SystemCaptureModule {
    override fun start(activity: Activity, sink: FrameSink) {
        SinkHolder.sink = sink
        activity.startActivity(
            Intent(activity, SystemCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION),
        )
    }

    override fun stop(context: Context) {
        context.stopService(Intent(context, SnitchProjectionService::class.java))
    }
}

/** The core's sink for the current capture session. */
internal object SinkHolder {
    @Volatile
    var sink: FrameSink? = null
}
