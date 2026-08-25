import { type CSSProperties } from 'react';
import { ULTRON_PRESENCE_COPY, type UltronPresenceState } from '../lib/ultronPresence';

const ULTRON_AVATAR_SRC = './brand/ultron-avatar.png';
const VOICE_BARS = [0, 1, 2, 3, 4, 5, 6];

interface UltronAvatarProps {
  presence: UltronPresenceState;
  size?: 'launcher' | 'panel' | 'chat' | 'stage';
  announce?: boolean;
  motionEnabled?: boolean;
}

export function UltronAvatar({ presence, size = 'launcher', announce = false, motionEnabled = false }: UltronAvatarProps) {
  const copy = ULTRON_PRESENCE_COPY[presence];

  return (
    <div
      className={`ultron-avatar-presence ultron-avatar-presence--${size}`}
      data-motion={motionEnabled ? 'on' : 'off'}
      data-presence={presence}
      aria-label={announce ? `Альтрон: ${copy.label}. ${copy.detail}` : undefined}
      aria-live={announce ? 'polite' : undefined}
      role={announce ? 'status' : undefined}
    >
      <span className="ultron-avatar-presence__halo" aria-hidden="true" />
      <span className="ultron-avatar-presence__orbit ultron-avatar-presence__orbit--outer" aria-hidden="true" />
      <span className="ultron-avatar-presence__orbit ultron-avatar-presence__orbit--inner" aria-hidden="true" />
      <span className="ultron-avatar-presence__portrait" aria-hidden="true">
        <img alt="" src={ULTRON_AVATAR_SRC} />
        <span className="ultron-avatar-presence__scan" />
        <span className="ultron-avatar-presence__aperture" />
      </span>
      <span className="ultron-avatar-presence__voice" aria-hidden="true">
        {VOICE_BARS.map((bar) => <i key={bar} style={{ '--voice-bar': bar } as CSSProperties} />)}
      </span>
    </div>
  );
}
