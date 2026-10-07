// JPEG encode/decode through ImageIO (no UIKit, safe off the main thread) and the
// cheap frame checksum the ring uses to drop unchanged frames: FNV-1a over every
// 16th byte of the downscaled bitmap.

import CoreGraphics
import Foundation
import ImageIO

enum ImageCoding {
    static func jpegData(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        let props = [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary
        CGImageDestinationAddImage(dest, image, props)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts = [kCGImageSourceShouldCacheImmediately as String: true] as CFDictionary
        return CGImageSourceCreateImageAtIndex(source, 0, opts)
    }

    /// FNV-1a (64-bit) over every 16th byte of the image's backing pixels.
    static func checksum(_ image: CGImage) -> String {
        guard let cfData = image.dataProvider?.data, let ptr = CFDataGetBytePtr(cfData) else {
            return UUID().uuidString
        }
        return checksum(bytes: ptr, count: CFDataGetLength(cfData))
    }

    static func checksum(bytes: UnsafePointer<UInt8>, count: Int) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        var i = 0
        while i < count {
            hash ^= UInt64(bytes[i])
            hash = hash &* 0x0000_0100_0000_01b3
            i += 16
        }
        return String(hash, radix: 16)
    }

    /// An sRGB BGRA (premultiplied first, little-endian) bitmap context.
    static func makeBGRAContext(width: Int, height: Int, data: UnsafeMutableRawPointer? = nil, bytesPerRow: Int = 0) -> CGContext? {
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        return CGContext(
            data: data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: space,
            bitmapInfo: info
        )
    }
}
