/*
 * The report sheet (spec §6): a Dialog with a transparent full-screen window
 * (dim 30 %) hosting a bottom card built from plain Views — no AndroidX, no
 * resources, sizes in dp/sp, light/dark from Configuration.uiMode.
 *
 * Card: drag handle + "Report" header with close; optional remote message;
 * type chips (first selected); multiline description (focused, 4–8 lines);
 * Screenshot checkbox + 44×88 dp thumbnail (tap → full-screen preview);
 * Video checkbox with "last [N] s" — digits only, −/+ steppers, bounded
 * 1…min(videoMaxSeconds, buffered seconds), caption "of 28 s recorded" or
 * "Nothing recorded yet"; a "More" section with email, "Pause recording" and
 * the SDK version; and Send (disabled while the description is empty and no
 * attachment is selected). Tapping the backdrop, swiping the card down, back
 * or close dismisses — asking first if the description isn't empty.
 *
 * The dialog is its own window, so the window-callback wrapper never sees its
 * touches and PixelCopy of the activity never records it.
 */
package io.github.monjar.snitch.ui

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import io.github.monjar.snitch.capture.Screenshot
import io.github.monjar.snitch.config.ReportTypeOption
import kotlin.math.max

internal class ReportSheetModel(
    val types: List<ReportTypeOption>,
    val preselectType: String?,
    val message: String?,
    val screenshotEnabled: Boolean,
    val videoEnabled: Boolean,
    val videoMaxSeconds: Int,
    /** Whether the frozen ring has any frame, and how much history it covers. */
    val hasFrames: Boolean,
    val bufferedMs: Long,
    val email: String?,
    val recordingPaused: Boolean,
    val sdkVersion: String,
)

internal class ReportDraft(
    val type: String,
    val description: String,
    val email: String?,
    val includeScreenshot: Boolean,
    /** 0 = no video. */
    val videoSeconds: Int,
)

internal interface ReportSheetListener {
    fun onSend(draft: ReportDraft)

    fun onPauseRecordingChanged(paused: Boolean)

    /** After the sheet is gone, sent or not. */
    fun onClosed()
}

internal class ReportDialog(
    private val activity: Activity,
    private val model: ReportSheetModel,
    private val listener: ReportSheetListener,
) : Dialog(activity, themeFor(activity)) {
    private val p = Palette.of(activity)
    private lateinit var root: FrameLayout
    private lateinit var card: LinearLayout
    private lateinit var description: EditText
    private lateinit var sendButton: Button
    private var screenshotCheck: CheckBox? = null
    private var thumbnail: ImageView? = null
    private var videoCheck: CheckBox? = null
    private var secondsField: EditText? = null
    private var emailField: EditText? = null
    private val chips = ArrayList<Pair<String, TextView>>()
    private var selectedType: String =
        model.types.firstOrNull { it.id == model.preselectType }?.id ?: model.types.firstOrNull()?.id ?: "bug"
    private var screenshot: Screenshot? = null
    private var screenshotFailed = false
    private var closing = false

    /** Upper bound of the seconds field; 0 when nothing is recorded. */
    private val maxSeconds: Int =
        if (!model.hasFrames) 0 else (model.bufferedMs / 1000).toInt().coerceIn(1, model.videoMaxSeconds)
    private var seconds: Int = minOf(DEFAULT_SECONDS, maxSeconds).coerceAtLeast(1)

    init {
        setOnDismissListener { listener.onClosed() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        super.onCreate(savedInstanceState)
        root = buildRoot()
        setContentView(root)
        setCanceledOnTouchOutside(false)
        val w = window ?: return
        w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        w.setDimAmount(0.3f)
        @Suppress("DEPRECATION")
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        if (Build.VERSION.SDK_INT >= 30) applyInsets30(w) else root.fitsSystemWindows = true
        if (Build.VERSION.SDK_INT >= 33) registerBack33()
        applyScreenshot()
        updateSend()
    }

    override fun onStart() {
        super.onStart()
        description.requestFocus()
        card.post {
            if (closing) return@post
            card.translationY = card.height.toFloat()
            card.animate().translationY(0f).setDuration(ENTER_MS).start()
        }
    }

    /** Main thread; may arrive before or after the sheet is shown. Null: the screenshot failed. */
    fun setScreenshot(shot: Screenshot?) {
        screenshot = shot
        screenshotFailed = shot == null
        if (::root.isInitialized) {
            applyScreenshot()
            updateSend()
        }
    }

    @Deprecated("Superseded by OnBackInvokedCallback on API 33+, registered in onCreate")
    override fun onBackPressed() {
        requestClose()
    }

    @TargetApi(33)
    private fun registerBack33() {
        onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { requestClose() }
    }

    @TargetApi(30)
    @Suppress("DEPRECATION") // setDecorFitsSystemWindows: deprecated on 35 only because edge-to-edge is then forced.
    private fun applyInsets30(w: Window) {
        w.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
    }

    // ── Layout ──────────────────────────────────────────────────────────────

    private fun buildRoot(): FrameLayout {
        val ctx = activity
        val root = FrameLayout(ctx).apply {
            isClickable = true
            setOnClickListener { requestClose() }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = topRoundedBackground(p.surface, ctx.dpf(20f))
            elevation = ctx.dpf(12f)
            setPadding(ctx.dp(16f), ctx.dp(8f), ctx.dp(16f), ctx.dp(16f))
            isClickable = true // keep taps on the card away from the backdrop
        }
        val screenWidth = ctx.resources.displayMetrics.widthPixels
        val cardWidth = if (screenWidth > ctx.dp(MAX_CARD_WIDTH_DP)) ctx.dp(MAX_CARD_WIDTH_DP) else ViewGroup.LayoutParams.MATCH_PARENT
        root.addView(card, FrameLayout.LayoutParams(cardWidth, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))

        val top = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        top.addView(
            View(ctx).apply {
                background = roundedBackground(p.handle, ctx.dpf(2f))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            },
            LinearLayout.LayoutParams(ctx.dp(36f), ctx.dp(4f)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = ctx.dp(6f)
            },
        )
        top.addView(header())
        model.message?.takeIf { it.isNotBlank() }?.let { msg ->
            top.addView(
                TextView(ctx).apply {
                    text = msg
                    textSp(14f)
                    setTextColor(p.secondary)
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = ctx.dp(8f) },
            )
        }
        attachSwipeToDismiss(top)
        card.addView(top)

        val content = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        content.addView(typeChips())
        description = EditText(ctx).apply {
            hint = Strings.WHAT_HAPPENED
            textSp(16f)
            setTextColor(p.onSurface)
            setHintTextColor(p.secondary)
            gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 4
            maxLines = 8
            isVerticalScrollBarEnabled = true
            filters = arrayOf(InputFilter.LengthFilter(10_000))
            background = roundedBackground(p.field, ctx.dpf(12f))
            setPadding(ctx.dp(12f), ctx.dp(10f), ctx.dp(12f), ctx.dp(10f))
            addTextChangedListener(afterChange { updateSend() })
        }
        content.addView(description, matchWrap().apply { topMargin = ctx.dp(12f) })
        if (model.screenshotEnabled) content.addView(screenshotRow(), matchWrap().apply { topMargin = ctx.dp(12f) })
        if (model.videoEnabled) content.addView(videoRow(), matchWrap().apply { topMargin = ctx.dp(8f) })
        content.addView(moreSection(), matchWrap().apply { topMargin = ctx.dp(8f) })

        val scroll = ScrollView(ctx).apply {
            isFillViewport = false
            addView(content)
        }
        // Weighted with WRAP_CONTENT height: shrinks (and scrolls) when the keyboard leaves too little room.
        card.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        sendButton = Button(ctx).apply {
            text = Strings.SEND
            isAllCaps = false
            textSp(16f)
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(p.onAccent)
            minHeight = ctx.dp(48f)
            stateListAnimator = null
            setOnClickListener { send() }
        }
        card.addView(sendButton, matchWrap().apply { topMargin = ctx.dp(12f) })
        return root
    }

    private fun header(): View {
        val ctx = activity
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(
            TextView(ctx).apply {
                text = Strings.REPORT
                textSp(20f)
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(p.onSurface)
                if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        row.addView(
            TextView(ctx).apply {
                text = "✕"
                textSp(18f)
                setTextColor(p.secondary)
                gravity = Gravity.CENTER
                contentDescription = Strings.CLOSE
                isClickable = true
                isFocusable = true
                setOnClickListener { requestClose() }
            },
            LinearLayout.LayoutParams(ctx.dp(48f), ctx.dp(48f)),
        )
        return row
    }

    private fun typeChips(): View {
        val ctx = activity
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        for (t in model.types) {
            val chip = TextView(ctx).apply {
                text = t.label
                textSp(14f)
                gravity = Gravity.CENTER
                minHeight = ctx.dp(36f)
                setPadding(ctx.dp(14f), ctx.dp(6f), ctx.dp(14f), ctx.dp(6f))
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    selectedType = t.id
                    styleChips()
                }
            }
            chips.add(t.id to chip)
            row.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = ctx.dp(8f) })
        }
        styleChips()
        return HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(row)
        }
    }

    private fun styleChips() {
        for ((id, chip) in chips) {
            val selected = id == selectedType
            chip.isSelected = selected
            chip.setTextColor(if (selected) p.onAccent else p.onSurface)
            chip.background = roundedBackground(if (selected) p.accent else p.field, activity.dpf(18f))
        }
    }

    private fun screenshotRow(): View {
        val ctx = activity
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val check = CheckBox(ctx).apply {
            text = Strings.SCREENSHOT
            textSp(16f)
            setTextColor(p.onSurface)
            isChecked = true
            setOnCheckedChangeListener { _, _ -> updateSend() }
        }
        screenshotCheck = check
        row.addView(check, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val thumb = ImageView(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = roundedBackground(p.field, ctx.dpf(6f), p.handle, max(1, ctx.dp(0.5f)))
            clipToOutline = true
            contentDescription = Strings.SCREENSHOT_PREVIEW
            setOnClickListener { preview() }
        }
        thumbnail = thumb
        row.addView(thumb, LinearLayout.LayoutParams(ctx.dp(44f), ctx.dp(88f)))
        return row
    }

    private fun videoRow(): View {
        val ctx = activity
        val column = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val enabled = maxSeconds > 0
        val check = CheckBox(ctx).apply {
            text = Strings.VIDEO
            textSp(16f)
            setTextColor(p.onSurface)
            isChecked = enabled
            isEnabled = enabled
            setOnCheckedChangeListener { _, _ -> updateSend() }
        }
        videoCheck = check
        row.addView(check, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val lastLabel = TextView(ctx).apply {
            text = Strings.LAST
            textSp(16f)
            setTextColor(if (enabled) p.onSurface else p.secondary)
        }
        row.addView(lastLabel)
        val field = EditText(ctx).apply {
            id = View.generateViewId()
            setText(seconds.toString())
            textSp(16f)
            setTextColor(p.onSurface)
            gravity = Gravity.CENTER
            inputType = InputType.TYPE_CLASS_NUMBER
            imeOptions = EditorInfo.IME_ACTION_DONE
            filters = arrayOf(InputFilter.LengthFilter(2), InputFilter { src, start, end, _, _, _ ->
                if ((start until end).all { src[it].isDigit() }) null else ""
            })
            isEnabled = enabled
            background = roundedBackground(p.field, ctx.dpf(8f))
            setPadding(ctx.dp(4f), ctx.dp(6f), ctx.dp(4f), ctx.dp(6f))
            setOnFocusChangeListener { _, hasFocus -> if (!hasFocus) setSeconds(currentFieldValue()) }
            setOnEditorActionListener { _, _, _ ->
                setSeconds(currentFieldValue())
                false
            }
        }
        lastLabel.labelFor = field.id
        secondsField = field
        row.addView(stepper("−", Strings.FEWER_SECONDS, enabled) { setSeconds(currentFieldValue() - 1) }, LinearLayout.LayoutParams(ctx.dp(40f), ctx.dp(40f)).apply { marginStart = ctx.dp(6f) })
        row.addView(field, LinearLayout.LayoutParams(ctx.dp(52f), ViewGroup.LayoutParams.WRAP_CONTENT))
        row.addView(stepper("+", Strings.MORE_SECONDS, enabled) { setSeconds(currentFieldValue() + 1) }, LinearLayout.LayoutParams(ctx.dp(40f), ctx.dp(40f)))
        row.addView(
            TextView(ctx).apply {
                text = Strings.SECONDS_UNIT
                textSp(16f)
                setTextColor(if (enabled) p.onSurface else p.secondary)
            },
        )
        column.addView(row)
        val bufferedSeconds = (model.bufferedMs / 1000).toInt().coerceIn(0, model.videoMaxSeconds)
        column.addView(
            TextView(ctx).apply {
                text = if (enabled) Strings.recordedOf(max(bufferedSeconds, 1)) else Strings.NOTHING_RECORDED
                textSp(12f)
                setTextColor(p.secondary)
                gravity = Gravity.END
            },
            matchWrap(),
        )
        return column
    }

    private fun stepper(label: String, a11yLabel: String, enabled: Boolean, onTap: () -> Unit): View =
        TextView(activity).apply {
            text = label
            textSp(20f)
            gravity = Gravity.CENTER
            setTextColor(if (enabled) p.accent else p.secondary)
            contentDescription = a11yLabel
            isEnabled = enabled
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
        }

    private fun moreSection(): View {
        val ctx = activity
        val column = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val details = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        val toggle = TextView(ctx).apply {
            text = "${Strings.MORE} ▸"
            textSp(14f)
            setTextColor(p.accent)
            minHeight = ctx.dp(40f)
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            isFocusable = true
        }
        toggle.setOnClickListener {
            val open = details.visibility != View.VISIBLE
            details.visibility = if (open) View.VISIBLE else View.GONE
            toggle.text = if (open) "${Strings.LESS} ▾" else "${Strings.MORE} ▸"
        }
        column.addView(toggle)
        val email = EditText(ctx).apply {
            hint = Strings.EMAIL
            setText(model.email ?: "")
            textSp(16f)
            setTextColor(p.onSurface)
            setHintTextColor(p.secondary)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            isSingleLine = true
            filters = arrayOf(InputFilter.LengthFilter(254))
            background = roundedBackground(p.field, ctx.dpf(12f))
            setPadding(ctx.dp(12f), ctx.dp(10f), ctx.dp(12f), ctx.dp(10f))
        }
        emailField = email
        details.addView(email, matchWrap())
        @Suppress("DEPRECATION") // android.widget.Switch: the only framework switch without AndroidX.
        val pause = Switch(ctx).apply {
            text = Strings.PAUSE_RECORDING
            textSp(16f)
            setTextColor(p.onSurface)
            isChecked = model.recordingPaused
            minHeight = ctx.dp(48f)
            setOnCheckedChangeListener { _, checked -> listener.onPauseRecordingChanged(checked) }
        }
        details.addView(pause, matchWrap().apply { topMargin = ctx.dp(8f) })
        details.addView(
            TextView(ctx).apply {
                text = Strings.sdkVersion(model.sdkVersion)
                textSp(12f)
                setTextColor(p.secondary)
            },
            matchWrap().apply { topMargin = ctx.dp(4f) },
        )
        column.addView(details, matchWrap())
        return column
    }

    private fun matchWrap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    // ── State ───────────────────────────────────────────────────────────────

    private fun currentFieldValue(): Int = secondsField?.text?.toString()?.toIntOrNull() ?: seconds

    private fun setSeconds(value: Int) {
        if (maxSeconds <= 0) return
        seconds = value.coerceIn(1, maxSeconds)
        val field = secondsField ?: return
        val text = seconds.toString()
        if (field.text.toString() != text) {
            field.setText(text)
            field.setSelection(text.length)
        }
        updateSend()
    }

    private fun applyScreenshot() {
        val check = screenshotCheck ?: return
        val thumb = thumbnail ?: return
        if (screenshotFailed) {
            check.isChecked = false
            check.isEnabled = false
            thumb.visibility = View.GONE
        } else {
            screenshot?.thumbnail?.let { thumb.setImageBitmap(it) }
        }
    }

    private fun hasAttachment(): Boolean {
        val shot = screenshotCheck?.let { it.isChecked && !screenshotFailed } ?: false
        val video = videoCheck?.let { it.isChecked && maxSeconds > 0 } ?: false
        return shot || video
    }

    private fun updateSend() {
        if (!::sendButton.isInitialized) return
        val enabled = description.text.toString().isNotBlank() || hasAttachment()
        sendButton.isEnabled = enabled
        sendButton.background = roundedBackground(if (enabled) p.accent else p.disabled, activity.dpf(12f))
    }

    private fun send() {
        if (closing) return
        if (videoCheck?.isChecked == true) setSeconds(currentFieldValue())
        val draft = ReportDraft(
            type = selectedType,
            description = description.text.toString().trim(),
            email = emailField?.text?.toString()?.trim()?.ifEmpty { null },
            includeScreenshot = screenshotCheck?.isChecked == true && !screenshotFailed,
            videoSeconds = if (videoCheck?.isChecked == true && maxSeconds > 0) seconds else 0,
        )
        closing = true
        hideKeyboard()
        dismissSafely()
        listener.onSend(draft)
    }

    /** Backdrop, swipe, back, close button. */
    private fun requestClose() {
        if (closing) return
        if (description.text.toString().isNotBlank()) {
            card.animate().translationY(0f).setDuration(SNAP_BACK_MS).start()
            val theme = if (p.dark) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
            AlertDialog.Builder(activity, theme)
                .setTitle(Strings.DISCARD_TITLE)
                .setPositiveButton(Strings.DISCARD) { _, _ -> closeAnimated() }
                .setNegativeButton(Strings.KEEP_EDITING, null)
                .show()
        } else {
            closeAnimated()
        }
    }

    private fun closeAnimated() {
        if (closing) return
        closing = true
        hideKeyboard()
        card.animate().translationY(card.height.toFloat()).setDuration(EXIT_MS).withEndAction { dismissSafely() }.start()
    }

    private fun dismissSafely() {
        try {
            if (isShowing) dismiss()
        } catch (_: Exception) {
            // The activity window is already gone.
        }
    }

    private fun hideKeyboard() {
        val imm = activity.getSystemService(Activity.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        window?.decorView?.windowToken?.let { imm.hideSoftInputFromWindow(it, 0) }
    }

    @SuppressLint("ClickableViewAccessibility") // Dragging is an extra; close and back stay available.
    private fun attachSwipeToDismiss(target: View) {
        var startY = 0f
        var dragging = false
        target.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startY = e.rawY
                    dragging = true
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (dragging) card.translationY = max(0f, e.rawY - startY)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        dragging = false
                        if (e.actionMasked == MotionEvent.ACTION_UP && card.translationY > card.height * SWIPE_FRACTION) {
                            requestClose()
                        } else {
                            card.animate().translationY(0f).setDuration(SNAP_BACK_MS).start()
                        }
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun preview() {
        val shot = screenshot ?: return
        val metrics = activity.resources.displayMetrics
        val opts = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (shot.width / (inSampleSize * 2) >= metrics.widthPixels && shot.height / (inSampleSize * 2) >= metrics.heightPixels / 2) inSampleSize *= 2
        }
        val bitmap: Bitmap = BitmapFactory.decodeByteArray(shot.jpeg, 0, shot.jpeg.size, opts) ?: return
        @Suppress("DEPRECATION")
        val d = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        val image = ImageView(activity).apply {
            setBackgroundColor(Color.BLACK)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setImageBitmap(bitmap)
            contentDescription = Strings.SCREENSHOT
            setOnClickListener { d.dismiss() }
        }
        d.setContentView(image)
        d.show()
    }

    private fun afterChange(block: () -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

        override fun afterTextChanged(s: Editable?) = block()
    }

    companion object {
        private const val DEFAULT_SECONDS = 15
        private const val MAX_CARD_WIDTH_DP = 560f
        private const val ENTER_MS = 220L
        private const val EXIT_MS = 180L
        private const val SNAP_BACK_MS = 150L
        private const val SWIPE_FRACTION = 0.25f

        fun themeFor(activity: Activity): Int =
            if (Palette.of(activity).dark) android.R.style.Theme_DeviceDefault_NoActionBar else android.R.style.Theme_DeviceDefault_Light_NoActionBar
    }
}
