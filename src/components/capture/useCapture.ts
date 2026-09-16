import { useEffect, useState } from 'react';
import { api, type CaptureFrames, type CaptureState } from '../../api';

const OUTSIDE_ELECTRON: CaptureState = {
  status: 'idle',
  armed: false,
  presentMon: { installed: false, message: 'Not running inside Electron' },
  target: null,
  startedAt: null,
  frames: 0,
  message: '',
  lastSessionId: null
};

/** The main process owns the capture; this is its state as pushed, seeded by one query on mount. */
export function useCaptureState(): CaptureState {
  const [state, setState] = useState<CaptureState>(OUTSIDE_ELECTRON);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.capture
      .state()
      .then((s) => live && setState(s))
      .catch(() => {
        /* the push channel catches up */
      });
    const off = api.capture.onState(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** The capture's word for the bottom bar, or null when nothing is running or armed. */
export function captureStatusLabel(s: CaptureState): string | null {
  if (s.status === 'capturing') return `Capturing${s.target ? ` ${s.target.exe}` : ''}`;
  if (s.status === 'saving') return 'Saving capture';
  return s.armed ? 'Game Mode armed' : null;
}

const NO_FRAMES: CaptureFrames = { count: 0, recentMs: [] };

/** 2 Hz while a capture runs: the count and the last two seconds of frame times. Cleared when the capture ends. */
export function useLiveFrames(capturing: boolean): CaptureFrames {
  const [frames, setFrames] = useState<CaptureFrames>(NO_FRAMES);
  useEffect(() => {
    if (!api || !capturing) {
      setFrames(NO_FRAMES);
      return;
    }
    return api.capture.onFrames(setFrames);
  }, [capturing]);
  return frames;
}
