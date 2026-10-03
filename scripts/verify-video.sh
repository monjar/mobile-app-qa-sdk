#!/usr/bin/env bash
# Checks an SDK-produced clip: H.264, sane duration, moov before mdat (plays
# while downloading), and every frame decodes without errors.
#   scripts/verify-video.sh path/to/video.mp4 [min_seconds] [max_seconds]
set -euo pipefail
f="$1"; min="${2:-0.5}"; max="${3:-31}"
[ -s "$f" ] || { echo "verify-video: $f missing or empty" >&2; exit 1; }

codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$f")
[ "$codec" = "h264" ] || { echo "verify-video: codec is '$codec', expected h264" >&2; exit 1; }

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
awk -v d="$dur" -v lo="$min" -v hi="$max" 'BEGIN { exit !(d >= lo && d <= hi) }' || { echo "verify-video: duration $dur outside [$min, $max]" >&2; exit 1; }

python3 - "$f" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
i, order = 0, []
while i + 8 <= len(data):
    size, kind = struct.unpack('>I4s', data[i:i+8])
    if size == 1: size = struct.unpack('>Q', data[i+8:i+16])[0]
    if size < 8: break
    order.append(kind.decode('latin1')); i += size
if 'moov' not in order: sys.exit('verify-video: no moov box')
if 'mdat' in order and order.index('moov') > order.index('mdat'): sys.exit('verify-video: moov after mdat (not fast-start)')
print('boxes:', ' '.join(order))
PY

ffmpeg -v error -i "$f" -f null - 2> /tmp/verify-video.err || true
if [ -s /tmp/verify-video.err ]; then echo "verify-video: decode errors:" >&2; cat /tmp/verify-video.err >&2; exit 1; fi
frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$f")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$f")
echo "verify-video: ok — h264 ${size}, ${dur}s, ${frames} frames"
