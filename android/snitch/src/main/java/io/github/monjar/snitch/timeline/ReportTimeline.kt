/*
 * Assembles a report's `timeline` attachment (spec §11.3) from what was frozen
 * when the sheet opened:
 *
 * - the recorder's snapshot (logs, requests, screens, app events);
 * - touch downs from the touch log, whose times are uptime milliseconds,
 *   converted with `wall = mono + (wallNow − monoNow)` taken once at freeze;
 * - logcat lines of this process read at send, when console capture was on,
 *   limited to the five minutes before the freeze;
 * - `meta.videoStart`/`videoEnd`: the composed clip's wall-clock span,
 *   `videoEnd = wall(endT)`, `videoStart = videoEnd − durationMs`.
 *
 * And, for the crash follow-up, the previous session's log as its own timeline.
 * Pure Kotlin + the logic/ encoder, so it is JVM-testable.
 */
package io.github.monjar.snitch.timeline

import io.github.monjar.snitch.capture.TouchSample
import io.github.monjar.snitch.logic.TimelineEvent
import io.github.monjar.snitch.logic.TimelineLimits
import io.github.monjar.snitch.logic.TimelineMeta
import io.github.monjar.snitch.logic.TimelineNdjson
import io.github.monjar.snitch.logic.TimelineSnapshot

internal object ReportTimeline {
    const val PLATFORM = "android"

    /** The live timeline of a report; null when there is nothing to show. */
    fun encode(
        snapshot: TimelineSnapshot,
        touchDowns: List<TouchSample>,
        wallOffset: Long,
        logcat: List<TimelineEvent.Log>,
        videoEndWall: Long?,
        videoDurationMs: Long?,
    ): TimelineNdjson.Encoded? {
        val events = ArrayList<TimelineEvent>(snapshot.events.size + touchDowns.size + logcat.size)
        events.addAll(snapshot.events)
        for (s in touchDowns.takeLast(TimelineLimits.TOUCHES)) {
            events.add(TimelineEvent.touch(s.t + wallOffset, s.fx.toDouble(), s.fy.toDouble(), s.fingers))
        }
        events.addAll(logcat)
        val videoEnd = if (videoDurationMs != null && videoDurationMs > 0) videoEndWall else null
        if (events.isEmpty() && videoEnd == null) return null
        val meta = TimelineMeta(
            platform = PLATFORM,
            start = snapshot.frozenAt,
            end = snapshot.frozenAt,
            videoStart = if (videoEnd != null && videoDurationMs != null) videoEnd - videoDurationMs else null,
            videoEnd = videoEnd,
            dropped = snapshot.dropped,
        )
        return TimelineNdjson.encode(meta, events)
    }

    /** A timeline of earlier events (the crash follow-up's previous session); null when empty. */
    fun encodePast(events: List<TimelineEvent>): TimelineNdjson.Encoded? {
        if (events.isEmpty()) return null
        val first = events.minOf { it.t }
        return TimelineNdjson.encode(TimelineMeta(PLATFORM, first, first), events)
    }
}
