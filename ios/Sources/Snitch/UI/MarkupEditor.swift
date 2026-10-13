// Screenshot markup (spec §11.7), the editing half: tapping the sheet's thumbnail
// opens the screenshot full screen with Arrow, Box and Blur tools, Undo, Clear,
// Cancel and Done. A drag draws the selected tool (previewed live as an outline);
// releasing commits it and the preview is re-rendered through MarkupRenderer, so
// what the tester sees is exactly what Done writes into the JPEG (quality 0.8),
// which then replaces the screenshot in the sheet. iOS 15 SwiftUI only.

import SwiftUI
import UIKit

final class MarkupEditorModel: ObservableObject {
    let base: CGImage
    /// Image pixels per point (the screenshot's screen scale).
    let scale: CGFloat
    let imageSize: CGSize

    @Published var tool: MarkupMark.Tool = .arrow
    @Published private(set) var marks: [MarkupMark] = []
    @Published private(set) var preview: UIImage
    /// The mark being dragged, not yet committed.
    @Published private(set) var draft: MarkupMark?

    /// Called with the edited screenshot on Done, or nil on Cancel / Done without marks.
    var onFinish: ((Screenshot?) -> Void)?

    init?(screenshot: Screenshot) {
        guard let image = ImageCoding.decode(screenshot.jpeg) else { return nil }
        base = image
        scale = max(1, screenshot.scale)
        imageSize = CGSize(width: image.width, height: image.height)
        preview = UIImage(cgImage: image)
    }

    /// Stroke width in image pixels: 4 pt at the screenshot's scale.
    var strokeWidth: CGFloat {
        MarkupRenderer.strokePoints * scale
    }

    /// Drags shorter than this (image pixels) are taps, not marks.
    private var minimumLength: CGFloat {
        6 * scale
    }

    func drag(from start: CGPoint, to end: CGPoint) {
        draft = MarkupMark(tool: tool, start: clamp(start), end: clamp(end))
    }

    func endDrag(from start: CGPoint, to end: CGPoint) {
        draft = nil
        let mark = MarkupMark(tool: tool, start: clamp(start), end: clamp(end))
        let long = hypot(mark.end.x - mark.start.x, mark.end.y - mark.start.y) >= minimumLength
        guard long, mark.tool == .arrow || (mark.rect.width >= 2 && mark.rect.height >= 2) else { return }
        marks.append(mark)
        rerender()
    }

    func undo() {
        guard !marks.isEmpty else { return }
        marks.removeLast()
        rerender()
    }

    func clear() {
        guard !marks.isEmpty else { return }
        marks.removeAll()
        rerender()
    }

    func cancel() {
        onFinish?(nil)
    }

    func done() {
        guard !marks.isEmpty,
              let rendered = MarkupRenderer.render(base, marks: marks, strokeWidth: strokeWidth),
              let jpeg = ImageCoding.jpegData(rendered, quality: ScreenshotTaker.jpegQuality) else {
            onFinish?(nil)
            return
        }
        let image = UIImage(cgImage: rendered, scale: scale, orientation: .up)
        onFinish?(Screenshot(
            jpeg: jpeg, width: rendered.width, height: rendered.height,
            thumbnail: ScreenshotTaker.thumbnail(of: image, scale: scale), scale: scale
        ))
    }

    private func rerender() {
        let rendered = marks.isEmpty ? base : (MarkupRenderer.render(base, marks: marks, strokeWidth: strokeWidth) ?? base)
        preview = UIImage(cgImage: rendered)
    }

    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x.clamped(0, imageSize.width), y: p.y.clamped(0, imageSize.height))
    }
}

struct MarkupEditor: View {
    @ObservedObject var model: MarkupEditorModel

    private static let red = Color(red: MarkupRenderer.strokeRGB.r, green: MarkupRenderer.strokeRGB.g, blue: MarkupRenderer.strokeRGB.b)

    var body: some View {
        VStack(spacing: 0) {
            topBar
            GeometryReader { geometry in
                canvas(fit: MarkupGeometry.fit(imageSize: model.imageSize, in: geometry.size), size: geometry.size)
            }
            .padding(.horizontal, 8)
            toolbar
        }
        .background(Color.black.ignoresSafeArea())
        .environment(\.colorScheme, .dark)
    }

    // MARK: - Bars

    private var topBar: some View {
        HStack {
            Button(Strings.cancel) { model.cancel() }
            Spacer()
            Button {
                model.done()
            } label: {
                Text(Strings.done).fontWeight(.semibold)
            }
        }
        .padding(.horizontal, Theme.padding)
        .padding(.vertical, 10)
    }

    private var toolbar: some View {
        HStack(spacing: 4) {
            toolButton(.arrow, symbol: "arrow.up.right", label: Strings.markupArrow)
            toolButton(.box, symbol: "rectangle", label: Strings.markupBox)
            toolButton(.blur, symbol: "square.grid.3x3.fill", label: Strings.markupBlur)
            Spacer(minLength: 8)
            barButton(symbol: "arrow.uturn.backward", label: Strings.undo) { model.undo() }
                .disabled(model.marks.isEmpty)
            barButton(symbol: "trash", label: Strings.clearMarks) { model.clear() }
                .disabled(model.marks.isEmpty)
        }
        .padding(.horizontal, Theme.padding)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(Strings.markupTools))
    }

    private func toolButton(_ tool: MarkupMark.Tool, symbol: String, label: String) -> some View {
        let selected = model.tool == tool
        return Button {
            model.tool = tool
        } label: {
            Image(systemName: symbol)
                .font(.title3)
                .frame(width: 48, height: 44)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(selected ? Color.white.opacity(0.22) : Color.clear)
                )
                .foregroundColor(selected ? MarkupEditor.red : .white)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }

    private func barButton(symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title3)
                .frame(width: 44, height: 44)
        }
        .foregroundColor(.white)
        .accessibilityLabel(Text(label))
    }

    // MARK: - Canvas

    private func canvas(fit: CGRect, size: CGSize) -> some View {
        let scale = model.imageSize.width > 0 ? fit.width / model.imageSize.width : 1
        func toImage(_ p: CGPoint) -> CGPoint {
            CGPoint(x: (p.x - fit.minX) / max(scale, 0.0001), y: (p.y - fit.minY) / max(scale, 0.0001))
        }
        func toView(_ p: CGPoint) -> CGPoint {
            CGPoint(x: fit.minX + p.x * scale, y: fit.minY + p.y * scale)
        }
        return ZStack(alignment: .topLeading) {
            Image(uiImage: model.preview)
                .resizable()
                .frame(width: fit.width, height: fit.height)
                .position(x: fit.midX, y: fit.midY)
                .accessibilityLabel(Text(Strings.markupCanvas))
                .accessibilityHint(Text(Strings.markupCanvasHint))
            if let draft = model.draft {
                draftView(draft, toView: toView, lineWidth: max(1, model.strokeWidth * scale))
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 2, coordinateSpace: .local)
                .onChanged { value in
                    model.drag(from: toImage(value.startLocation), to: toImage(value.location))
                }
                .onEnded { value in
                    model.endDrag(from: toImage(value.startLocation), to: toImage(value.location))
                }
        )
    }

    @ViewBuilder
    private func draftView(_ mark: MarkupMark, toView: (CGPoint) -> CGPoint, lineWidth: CGFloat) -> some View {
        let start = toView(mark.start)
        let end = toView(mark.end)
        switch mark.tool {
        case .arrow:
            let head = MarkupGeometry.arrowHead(from: start, to: end, width: lineWidth)
            let shaftEnd = MarkupGeometry.shaftEnd(from: start, to: end, width: lineWidth)
            ZStack {
                Path { path in
                    path.move(to: start)
                    path.addLine(to: shaftEnd)
                }
                .stroke(MarkupEditor.red, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                if head.count == 3 {
                    Path { path in
                        path.addLines(head)
                        path.closeSubpath()
                    }
                    .fill(MarkupEditor.red)
                }
            }
            .allowsHitTesting(false)
        case .box:
            Path(CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y)))
                .stroke(MarkupEditor.red, style: StrokeStyle(lineWidth: lineWidth, lineJoin: .round))
                .allowsHitTesting(false)
        case .blur:
            let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
            ZStack {
                Path(rect).fill(Color.white.opacity(0.25))
                Path(rect).stroke(Color.white, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
            }
            .allowsHitTesting(false)
        }
    }
}
