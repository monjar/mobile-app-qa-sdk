/**
 * The report clip: the native <video> plus what triage needs on top of it (slow
 * motion, frame stepping, a precise clock, keyboard shortcuts), reporting its
 * playhead so the timeline can follow along.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { AttachmentView } from '@snitch/contract';
import { CLIP_FPS, clock, stepFrames, stepSeconds } from '../lib/timeline';
import { StepBack, StepForward } from './icons';

export interface Playhead {
  /** Seconds into the clip. */
  time: number;
  playing: boolean;
}

const RATES = [0.25, 0.5, 1, 2];

/**
 * `onPlayhead` fires on play, pause, seek and once per frame while playing; never
 * before someone touches the clip, so the timeline highlights nothing until then.
 */
export function VideoPlayer({ a, videoRef, playhead, onPlayhead }: { a: AttachmentView; videoRef: RefObject<HTMLVideoElement | null>; playhead: Playhead | null; onPlayhead: (p: Playhead) => void }) {
  const [rate, setRate] = useState(1);
  const [duration, setDuration] = useState(a.durationMs ? a.durationMs / 1000 : NaN);
  const hintId = useId();
  const report = useRef(onPlayhead);
  useEffect(() => {
    report.current = onPlayhead;
  }, [onPlayhead]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    let lastFrame = -1;
    const emit = () => report.current({ time: v.currentTime, playing: !v.paused && !v.ended });
    // Once per video frame rather than per animation frame: the clip is 10 fps.
    const tick = () => {
      const frame = Math.floor(v.currentTime * CLIP_FPS + 1e-6);
      if (frame !== lastFrame) {
        lastFrame = frame;
        emit();
      }
      raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      lastFrame = -1;
      raf = requestAnimationFrame(tick);
    };
    const onStop = () => {
      cancelAnimationFrame(raf);
      emit();
    };
    const onMeta = () => {
      if (Number.isFinite(v.duration)) setDuration(v.duration);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onStop);
    v.addEventListener('ended', onStop);
    v.addEventListener('seeked', emit);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('durationchange', onMeta);
    onMeta();
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onStop);
      v.removeEventListener('ended', onStop);
      v.removeEventListener('seeked', emit);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onMeta);
    };
  }, [videoRef]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // A new source resets playbackRate to defaultPlaybackRate, so set both.
    v.defaultPlaybackRate = rate;
    v.playbackRate = rate;
  }, [rate, videoRef]);

  // Seeking an element that hasn't loaded yet fires no `seeked`, so report the new position directly.
  const seekTo = (seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    onPlayhead({ time: v.currentTime, playing: !v.paused && !v.ended });
  };
  const step = (frames: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    seekTo(stepFrames(v.currentTime, frames, duration));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || e.altKey || e.metaKey || e.ctrlKey) return;
    // Space on one of the buttons below presses that button.
    const onButton = e.target instanceof HTMLButtonElement;
    if (e.key === ' ' && !onButton) {
      // preventDefault also keeps the native controls (when the video has focus) from toggling it back.
      e.preventDefault();
      if (v.paused || v.ended) void v.play().catch(() => undefined);
      else v.pause();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) seekTo(stepSeconds(v.currentTime, dir, duration));
      else step(dir);
    }
  };

  return (
    <figure>
      <div className="player" tabIndex={0} role="group" aria-label="Recording" aria-describedby={hintId} onKeyDown={onKeyDown}>
        <video ref={videoRef} className="clip" src={a.url} controls playsInline preload="metadata" />
        <div className="player-bar">
          <div className="segmented" role="group" aria-label="Playback speed">
            {RATES.map((r) => (
              <button key={r} type="button" className={`small ${rate === r ? 'primary' : 'ghost'}`} aria-pressed={rate === r} onClick={() => setRate(r)}>
                {r}×
              </button>
            ))}
          </div>
          <span className="spacer" />
          <span className="mono small player-time">
            {clock(playhead?.time ?? 0)} / {Number.isFinite(duration) ? clock(duration) : '–:––'}
          </span>
        </div>
        <div className="player-bar">
          <button type="button" className="small ghost icon-button" aria-label="Previous frame" title="Previous frame (←)" onClick={() => step(-1)}>
            <StepBack />
          </button>
          <button type="button" className="small ghost icon-button" aria-label="Next frame" title="Next frame (→)" onClick={() => step(1)}>
            <StepForward />
          </button>
          <span className="spacer" />
          <span id={hintId} className="muted player-hint">
            <span className="kbd">Space</span> play · <span className="kbd">←/→</span> frame · <span className="kbd">⇧←/→</span> 1 s
          </span>
        </div>
      </div>
      <figcaption>
        <span>{a.durationMs ? `${(a.durationMs / 1000).toFixed(0)} s recording` : 'Recording'}</span>
        <a href={a.url} target="_blank" rel="noreferrer">
          Open
        </a>
      </figcaption>
    </figure>
  );
}
