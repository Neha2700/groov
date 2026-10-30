// Minimal typings for the parts of the YouTube IFrame Player API we use.
declare namespace YT {
  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }

  interface OnStateChangeEvent {
    data: PlayerState;
    target: Player;
  }

  interface PlayerOptions {
    height?: string;
    width?: string;
    playerVars?: Record<string, string | number>;
    events?: {
      onReady?: (e: { target: Player }) => void;
      onStateChange?: (e: OnStateChangeEvent) => void;
    };
  }

  class Player {
    constructor(el: HTMLElement | string, options: PlayerOptions);
    loadVideoById(videoId: string, startSeconds?: number): void;
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): PlayerState;
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    /** Undocumented; used to switch off captions. */
    unloadModule?(name: string): void;
  }
}

interface Window {
  YT: typeof YT;
  onYouTubeIframeAPIReady?: () => void;
}
