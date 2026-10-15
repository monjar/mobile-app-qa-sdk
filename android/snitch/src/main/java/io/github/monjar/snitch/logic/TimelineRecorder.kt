/*
 * The in-memory timeline (spec §11.3): one ring per kind with the contract's
 * TIMELINE_LIMITS (500 log lines, 100 requests, 50 screens, 50 app events;
 * nothing older than 5 minutes). Touch downs are not kept here: the runtime
 * converts them from the touch log when it freezes a report.
 *
 * Recording is gated by switches the runtime sets from the static options and
 * the remote config (`configure`): while Snitch is off, or a kind is switched
 * off, the record calls return at once and keep nothing. The switches are plain
 * volatile reads, so callers on hot paths (the OkHttp interceptor) pay a flag
 * check and nothing else.
 *
 * Requests are recorded when they finish, so the OkHttp interceptor also
 * registers each one as it starts ([requestStarted]); one still running at
 * freeze goes into the snapshot as `error: "in flight"` with `ms` up to the
 * freeze. That keeps a request that hangs — often the bug being reported — in
 * the report.
 *
 * Thread-safe: records arrive from any thread (Snitch.log, network threads, the
 * main thread's lifecycle callbacks). Pure Kotlin; the clock is injected.
 */
package io.github.monjar.snitch.logic

/** What [TimelineRecorder.freeze] hands to a report. */
class TimelineSnapshot(
    /** Every kept event (no touches), oldest first per kind. */
    val events: List<TimelineEvent>,
    /** Events dropped because a ring was full. */
    val dropped: Int,
    /** The newest screen name, unless the app cleared it with setScreen(null). */
    val screen: String?,
    /** Whether console capture was on at freeze time (logcat is read at send only then). */
    val console: Boolean,
    /** Wall-clock time of the freeze. */
    val frozenAt: Long,
)

class TimelineRecorder(private val clock: () -> Long = { System.currentTimeMillis() }) {
    @Volatile
    var active = false
        private set

    @Volatile
    var consoleOn = false
        private set

    @Volatile
    var networkOn = false
        private set

    @Volatile
    var screensOn = false
        private set

    private val logs = ArrayDeque<TimelineEvent.Log>()
    private val network = ArrayDeque<TimelineEvent.Net>()
    private val screens = ArrayDeque<TimelineEvent.Screen>()
    private val app = ArrayDeque<TimelineEvent.App>()

    /** Started and not yet recorded, by id, oldest first; `ms` is filled in at freeze. */
    private val running = LinkedHashMap<Long, TimelineEvent.Net>()
    private var lastRequestId = 0L
    private var dropped = 0
    private var currentScreen: String? = null
    private var logCount = 0L

    /** Sets what may be recorded; every kind is off while [active] is false. */
    fun configure(active: Boolean, console: Boolean, network: Boolean, screens: Boolean) {
        this.active = active
        consoleOn = active && console
        networkOn = active && network
        screensOn = active && screens
        if (!networkOn) synchronized(this) { running.clear() }
    }

    /** Increases with every recorded log line (so a persister can skip unchanged rings). */
    val logVersion: Long
        get() = synchronized(this) { logCount }

    fun log(level: String, src: String, msg: String, tag: String? = null): Boolean {
        if (!consoleOn) return false
        val e = TimelineEvent.log(clock(), level, src, msg, tag)
        synchronized(this) {
            push(logs, e, TimelineLimits.LOGS)
            logCount++
        }
        return true
    }

    /**
     * A request started at [t]; until [net] records it with the returned id, [freeze] reports it
     * as in flight. 0 while network capture is off. At most TIMELINE_LIMITS.network are tracked;
     * beyond that the oldest is forgotten (a request whose end never came).
     */
    fun requestStarted(t: Long, method: String, url: String): Long {
        if (!networkOn) return 0
        val e = TimelineEvent.net(t, method, url, null, null, null, null, TimelineEvent.NET_IN_FLIGHT)
        synchronized(this) {
            val id = ++lastRequestId
            running[id] = e
            if (running.size > TimelineLimits.NETWORK) running.remove(running.keys.first())
            return id
        }
    }

    /** The request [requestStarted] returned [id] for ended without being recorded. */
    fun requestEnded(id: Long) {
        if (id <= 0) return
        synchronized(this) { running.remove(id) }
    }

    /** A finished (or failed) request; [requestId] is what [requestStarted] returned for it. */
    fun net(
        t: Long,
        method: String,
        url: String,
        status: Int?,
        ms: Double?,
        reqBytes: Long?,
        resBytes: Long?,
        error: String?,
        requestId: Long = 0,
    ): Boolean {
        requestEnded(requestId)
        if (!networkOn) return false
        val e = TimelineEvent.net(t, method, url, status, ms, reqBytes, resBytes, error)
        synchronized(this) { push(network, e, TimelineLimits.NETWORK) }
        return true
    }

    /** Records a screen change; false when off, blank, or the same screen as the current one. */
    fun screen(name: String, src: String): Boolean {
        if (!screensOn) return false
        val e = TimelineEvent.screen(clock(), name, src) ?: return false
        synchronized(this) {
            if (e.name == currentScreen) return false
            currentScreen = e.name
            push(screens, e, TimelineLimits.SCREENS)
        }
        return true
    }

    /** The app said no screen is showing (setScreen(null)): the next report has no `screen`. */
    fun clearScreen() {
        synchronized(this) { currentScreen = null }
    }

    fun app(event: String): Boolean {
        if (!active) return false
        val e = TimelineEvent.app(clock(), event) ?: return false
        synchronized(this) { push(app, e, TimelineLimits.APP) }
        return true
    }

    /** A copy of everything recorded in the last 5 minutes. */
    fun freeze(): TimelineSnapshot {
        val now = clock()
        val cutoff = now - TimelineLimits.MAX_AGE_MS
        synchronized(this) {
            val out = ArrayList<TimelineEvent>(logs.size + network.size + screens.size + app.size)
            for (ring in listOf(app, screens, network, logs)) {
                for (e in ring) if (e.t >= cutoff) out.add(e)
            }
            for (e in running.values) {
                if (e.t >= cutoff && e.t <= now) out.add(e.copy(ms = (now - e.t).toDouble()))
            }
            return TimelineSnapshot(out, dropped, currentScreen, consoleOn, now)
        }
    }

    /** The newest [max] log lines (for the crash follow-up's session log). */
    fun recentLogs(max: Int): List<TimelineEvent.Log> = synchronized(this) {
        val skip = maxOf(0, logs.size - max)
        logs.drop(skip)
    }

    private fun <E : TimelineEvent> push(ring: ArrayDeque<E>, e: E, limit: Int) {
        val cutoff = e.t - TimelineLimits.MAX_AGE_MS
        while (ring.isNotEmpty() && ring.first().t < cutoff) ring.removeFirst()
        ring.addLast(e)
        while (ring.size > limit) {
            ring.removeFirst()
            dropped++
        }
    }
}
