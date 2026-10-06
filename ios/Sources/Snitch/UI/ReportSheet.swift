// The report sheet (spec §6): a bottom card on .ultraThinMaterial over a dimmed
// backdrop. Type chips, a focused multiline description, screenshot and video
// rows, a "More" disclosure and Send. System fonts and colors only, so light/dark
// and Dynamic Type work out of the box. iOS 15 APIs only.

import SwiftUI

struct ReportSheet: View {
    @ObservedObject var model: ReportSheetModel
    @FocusState private var focus: Field?
    @State private var dragOffset: CGFloat = 0

    enum Field: Hashable {
        case text
        case seconds
        case email
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black
                .opacity(model.isShown ? Theme.backdropOpacity : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { model.requestDismiss() }
                .accessibilityHidden(true)

            if model.isShown {
                card
                    .transition(.move(edge: .bottom))
            }

            if let image = model.previewImage {
                preview(image)
                    .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.9), value: model.isShown)
        .animation(.easeInOut(duration: 0.2), value: model.previewImage != nil)
        .alert(Strings.discardTitle, isPresented: $model.confirmDiscard) {
            Button(Strings.discard, role: .destructive) { model.dismiss() }
            Button(Strings.keepEditing, role: .cancel) {}
        }
        .onAppear {
            model.isShown = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                if model.isShown { focus = .text }
            }
        }
        .onChange(of: focus) { newValue in
            if newValue != .seconds { model.commitSeconds() }
        }
    }

    // MARK: - Card

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let message = model.message {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            typeChips
            descriptionEditor
            if model.hasScreenshot { screenshotRow }
            if model.videoAvailable { videoRow }
            moreSection
            sendButton
        }
        .padding(Theme.padding)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .offset(y: max(0, dragOffset))
    }

    private var header: some View {
        VStack(spacing: 6) {
            Capsule()
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 36, height: 5)
                .accessibilityHidden(true)
            HStack {
                Text(Strings.reportTitle)
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.requestDismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(Strings.close))
            }
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in dragOffset = value.translation.height }
                .onEnded { value in
                    if value.translation.height > 120 {
                        model.requestDismiss()
                    }
                    withAnimation(.spring()) { dragOffset = 0 }
                }
        )
    }

    private var typeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.reportTypes, id: \.id) { option in
                    chip(option)
                }
            }
        }
        .accessibilityLabel(Text(Strings.reportTypeLabel))
    }

    private func chip(_ option: ReportTypeOption) -> some View {
        let selected = model.selectedType == option.id
        return Button {
            model.selectedType = option.id
        } label: {
            Text(option.label)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Capsule().fill(selected ? Color.accentColor : Color(.tertiarySystemFill)))
                .foregroundColor(selected ? .white : .primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }

    private var descriptionEditor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $model.text)
                .focused($focus, equals: .text)
                .frame(minHeight: 88, maxHeight: 176)
                .accessibilityLabel(Text(Strings.descriptionLabel))
            if model.text.isEmpty {
                Text(Strings.descriptionPlaceholder)
                    .foregroundColor(Color(.placeholderText))
                    .padding(.top, 8)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    private var screenshotRow: some View {
        HStack(spacing: 12) {
            CheckboxToggle(title: Strings.screenshot, isOn: $model.includeScreenshot)
            Spacer()
            if let thumb = model.thumbnail {
                Button {
                    focus = nil
                    model.openPreview()
                } label: {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: Theme.thumbnailSize.width, height: Theme.thumbnailSize.height)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .stroke(Color.primary.opacity(0.15), lineWidth: 1)
                        )
                        .opacity(model.includeScreenshot ? 1 : 0.4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(Strings.screenshotPreview))
            }
        }
    }

    private var videoRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                CheckboxToggle(title: Strings.video, isOn: $model.includeVideo)
                    .disabled(!model.hasRecording)
                if model.hasRecording {
                    Text(Strings.videoLast)
                        .foregroundColor(.secondary)
                    TextField("", text: Binding(
                        get: { model.secondsText },
                        set: { model.setSecondsText($0) }
                    ))
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .focused($focus, equals: .seconds)
                    .frame(width: 44)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(.tertiarySystemFill)))
                    .accessibilityLabel(Text(Strings.videoSecondsLabel))
                    Text(Strings.secondsUnit)
                        .foregroundColor(.secondary)
                    Spacer(minLength: 0)
                    stepper
                }
            }
            Text(model.hasRecording ? Strings.recordedCaption(model.recordedSeconds) : Strings.nothingRecorded)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .opacity(model.includeVideo || !model.hasRecording ? 1 : 0.6)
    }

    private var stepper: some View {
        HStack(spacing: 0) {
            Button {
                model.stepSeconds(-1)
            } label: {
                Image(systemName: "minus")
                    .frame(width: 36, height: 30)
            }
            .disabled(model.seconds <= 1)
            .accessibilityLabel(Text(Strings.decreaseSeconds))
            Divider().frame(height: 18)
            Button {
                model.stepSeconds(1)
            } label: {
                Image(systemName: "plus")
                    .frame(width: 36, height: 30)
            }
            .disabled(model.seconds >= model.maxSeconds)
            .accessibilityLabel(Text(Strings.increaseSeconds))
        }
        .buttonStyle(.plain)
        .foregroundColor(.accentColor)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
    }

    private var moreSection: some View {
        DisclosureGroup(isExpanded: $model.showMore) {
            VStack(alignment: .leading, spacing: 10) {
                TextField(Strings.emailPlaceholder, text: $model.email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .focused($focus, equals: .email)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(Text(Strings.email))
                Toggle(Strings.pauseRecording, isOn: $model.pauseRecording)
                Text(Strings.sdkVersion(model.version))
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
            .padding(.top, 8)
        } label: {
            Text(Strings.more)
                .font(.subheadline)
                .foregroundColor(.primary)
        }
    }

    private var sendButton: some View {
        Button {
            focus = nil
            model.send()
        } label: {
            Text(Strings.send)
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!model.canSend)
    }

    // MARK: - Full-screen screenshot preview

    private func preview(_ image: UIImage) -> some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(Text(Strings.screenshotPreview))
            Button {
                model.closePreview()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.largeTitle)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundColor(.white)
                    .padding()
            }
            .accessibilityLabel(Text(Strings.close))
        }
        .contentShape(Rectangle())
        .onTapGesture { model.closePreview() }
    }
}

/// A checkbox-style toggle (iOS has no checkbox ToggleStyle).
struct CheckboxToggle: View {
    let title: String
    @Binding var isOn: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundColor(isOn && isEnabled ? .accentColor : .secondary)
                Text(title)
                    .foregroundColor(isEnabled ? .primary : .secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(isOn ? "On" : "Off"))
        .accessibilityAddTraits(.isButton)
    }
}
