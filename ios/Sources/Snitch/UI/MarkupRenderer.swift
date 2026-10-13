// Screenshot markup (spec §11.7), the drawing half: arrows, boxes and blur
// applied to the screenshot's own pixels, in the order they were made.
//
// - Marks are in image pixels with a top-left origin, like the screenshot.
// - Strokes are #FF3B30, 4 pt scaled to image pixels by the screenshot's scale.
// - Blur pixelates: each 16-pixel block of the image grid that the rectangle
//   covers is replaced by the average of its covered pixels, so what was under it
//   can't be recovered from the file. Masks drawn at capture time are part of the
//   pixels already and stay.
// CoreGraphics only (no UIKit), so the result is unit-tested pixel by pixel.

import CoreGraphics
import Foundation

struct MarkupMark: Equatable {
    enum Tool: String, CaseIterable {
        case arrow, box, blur
    }

    var tool: Tool
    var start: CGPoint
    var end: CGPoint

    /// The rectangle spanned by the drag (box and blur).
    var rect: CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
    }
}

enum MarkupGeometry {
    /// Where an image of `imageSize` sits when aspect-fitted and centred in `container`.
    static func fit(imageSize: CGSize, in container: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, container.width > 0, container.height > 0 else { return .zero }
        let s = min(container.width / imageSize.width, container.height / imageSize.height)
        let w = imageSize.width * s
        let h = imageSize.height * s
        return CGRect(x: (container.width - w) / 2, y: (container.height - h) / 2, width: w, height: h)
    }

    /// The arrowhead triangle (tip, then the two base corners) for a stroke of `width`.
    static func arrowHead(from start: CGPoint, to end: CGPoint, width: CGFloat) -> [CGPoint] {
        let dx = end.x - start.x
        let dy = end.y - start.y
        let length = hypot(dx, dy)
        guard length > 0 else { return [] }
        let ux = dx / length
        let uy = dy / length
        let headLength = min(max(width * 4, 1), length)
        let halfWidth = max(width * 2.2, 1)
        let base = CGPoint(x: end.x - ux * headLength, y: end.y - uy * headLength)
        return [
            end,
            CGPoint(x: base.x - uy * halfWidth, y: base.y + ux * halfWidth),
            CGPoint(x: base.x + uy * halfWidth, y: base.y - ux * halfWidth),
        ]
    }

    /// Where the shaft ends: at the base of the head, so the line cap never pokes past the tip.
    static func shaftEnd(from start: CGPoint, to end: CGPoint, width: CGFloat) -> CGPoint {
        let head = arrowHead(from: start, to: end, width: width)
        guard head.count == 3 else { return end }
        return CGPoint(x: (head[1].x + head[2].x) / 2, y: (head[1].y + head[2].y) / 2)
    }
}

enum MarkupRenderer {
    static let blockSize = 16
    static let strokePoints: CGFloat = 4
    /// #FF3B30
    static let strokeRGB: (r: CGFloat, g: CGFloat, b: CGFloat) = (1, 0x3B / 255.0, 0x30 / 255.0)

    /// `image` with `marks` applied in order; `strokeWidth` in image pixels.
    static func render(_ image: CGImage, marks: [MarkupMark], strokeWidth: CGFloat) -> CGImage? {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0, let ctx = ImageCoding.makeBGRAContext(width: width, height: height) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        for mark in marks {
            switch mark.tool {
            case .blur:
                pixelate(ctx, rect: mark.rect, width: width, height: height)
            case .box:
                inTopLeftSpace(ctx, height: height) {
                    stroke(ctx, width: strokeWidth)
                    ctx.stroke(mark.rect)
                }
            case .arrow:
                inTopLeftSpace(ctx, height: height) {
                    drawArrow(ctx, from: mark.start, to: mark.end, width: strokeWidth)
                }
            }
        }
        return ctx.makeImage()
    }

    /// Runs `draw` with the CTM flipped so (0, 0) is the image's top-left pixel.
    private static func inTopLeftSpace(_ ctx: CGContext, height: Int, _ draw: () -> Void) {
        ctx.saveGState()
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1, y: -1)
        draw()
        ctx.restoreGState()
    }

    private static func stroke(_ ctx: CGContext, width: CGFloat) {
        ctx.setStrokeColor(red: strokeRGB.r, green: strokeRGB.g, blue: strokeRGB.b, alpha: 1)
        ctx.setFillColor(red: strokeRGB.r, green: strokeRGB.g, blue: strokeRGB.b, alpha: 1)
        ctx.setLineWidth(max(1, width))
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
    }

    private static func drawArrow(_ ctx: CGContext, from start: CGPoint, to end: CGPoint, width: CGFloat) {
        let head = MarkupGeometry.arrowHead(from: start, to: end, width: width)
        guard head.count == 3 else { return }
        stroke(ctx, width: width)
        ctx.move(to: start)
        ctx.addLine(to: MarkupGeometry.shaftEnd(from: start, to: end, width: width))
        ctx.strokePath()
        ctx.move(to: head[0])
        ctx.addLine(to: head[1])
        ctx.addLine(to: head[2])
        ctx.closePath()
        ctx.fillPath()
    }

    /// Replaces every 16-px grid block inside `rect` (clipped to it) with its average colour,
    /// directly in the context's memory: row 0 of a bitmap context is the image's top row.
    static func pixelate(_ ctx: CGContext, rect: CGRect, width: Int, height: Int) {
        guard let base = ctx.data?.assumingMemoryBound(to: UInt8.self), !rect.isNull, !rect.isInfinite else { return }
        let bytesPerRow = ctx.bytesPerRow
        let x0 = max(0, Int(rect.minX.rounded(.down)))
        let y0 = max(0, Int(rect.minY.rounded(.down)))
        let x1 = min(width, Int(rect.maxX.rounded(.up)))
        let y1 = min(height, Int(rect.maxY.rounded(.up)))
        guard x1 > x0, y1 > y0 else { return }
        var blockTop = (y0 / blockSize) * blockSize
        while blockTop < y1 {
            let top = max(blockTop, y0)
            let bottom = min(blockTop + blockSize, y1)
            var blockLeft = (x0 / blockSize) * blockSize
            while blockLeft < x1 {
                let left = max(blockLeft, x0)
                let right = min(blockLeft + blockSize, x1)
                var sums = [UInt64](repeating: 0, count: 4)
                for y in top..<bottom {
                    let row = base + y * bytesPerRow
                    for x in left..<right {
                        let p = row + x * 4
                        sums[0] += UInt64(p[0])
                        sums[1] += UInt64(p[1])
                        sums[2] += UInt64(p[2])
                        sums[3] += UInt64(p[3])
                    }
                }
                let count = UInt64((bottom - top) * (right - left))
                let average = sums.map { UInt8(($0 + count / 2) / count) }
                for y in top..<bottom {
                    let row = base + y * bytesPerRow
                    for x in left..<right {
                        let p = row + x * 4
                        p[0] = average[0]
                        p[1] = average[1]
                        p[2] = average[2]
                        p[3] = average[3]
                    }
                }
                blockLeft += blockSize
            }
            blockTop += blockSize
        }
    }
}
