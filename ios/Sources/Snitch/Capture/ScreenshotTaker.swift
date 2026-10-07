// Window drawing shared by snapshot frames and screenshots, and the trigger-time
// screenshot itself (spec §5.6): the active scene's app windows at the native
// screen scale, masks applied, kept in memory as JPEG (quality 0.8).
//
// Renderers: drawHierarchy captures what is on screen including most Metal and
// video content but has crashed on some iOS releases; layer.render(in:) is the
// conservative fallback that misses Metal/OpenGL/video layers.

import UIKit

enum WindowRenderer {
    /// Draws `windows` into `ctx`, whose CTM maps scene points (top-left origin) to the context.
    static func draw(_ windows: [UIWindow], renderer: SnapshotRenderer, in ctx: CGContext) {
        UIGraphicsPushContext(ctx)
        defer { UIGraphicsPopContext() }
        for window in windows {
            switch renderer {
            case .drawHierarchy:
                window.drawHierarchy(in: window.frame, afterScreenUpdates: false)
            case .layerRender:
                ctx.saveGState()
                ctx.translateBy(x: window.frame.origin.x, y: window.frame.origin.y)
                window.layer.render(in: ctx)
                ctx.restoreGState()
            }
        }
    }
}

struct Screenshot {
    var jpeg: Data
    var width: Int
    var height: Int
    var thumbnail: UIImage?
}

enum ScreenshotTaker {
    static let jpegQuality = 0.8

    static func take(renderer: SnapshotRenderer, maskTextInputs: Bool) -> Screenshot? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let scene = AppWindows.activeScene() else { return nil }
        let windows = AppWindows.visibleWindows(in: scene)
        guard !windows.isEmpty else { return nil }
        let bounds = scene.coordinateSpace.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = scene.screen.scale

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let masks = Masker.rects(in: windows, maskTextInputs: maskTextInputs)
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { rendererContext in
            let ctx = rendererContext.cgContext
            ctx.setFillColor(UIColor.black.cgColor)
            ctx.fill(bounds)
            WindowRenderer.draw(windows, renderer: renderer, in: ctx)
            Masker.draw(masks, in: ctx, pixelsPerPoint: scale)
        }
        guard let cgImage = image.cgImage, let jpeg = ImageCoding.jpegData(cgImage, quality: jpegQuality) else {
            return nil
        }
        let thumb = image.preparingThumbnail(of: CGSize(width: 44 * scale, height: 88 * scale))
        return Screenshot(jpeg: jpeg, width: cgImage.width, height: cgImage.height, thumbnail: thumb ?? image)
    }
}
