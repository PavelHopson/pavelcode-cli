import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { BookOpen, Plus, Settings2 } from 'lucide-react';
import { SettingsPanel } from './components/SettingsPanel';
import { BrandLockup } from './components/BrandMark';
import { UsageGuide } from './components/UsageGuide';
import { UltronAvatar } from './components/UltronAvatar';
import { type ChatSession, type Message, createSession, loadSessions, saveSessions, VOICE_MODEL_ID } from './lib/ai';
import { type ContactTurn, type UltronPresenceState } from './lib/ultronPresence';

const VoiceConversation = lazy(() => import('./components/UltronVoiceConversation').then((module) => ({ default: module.UltronVoiceConversation })));
const VoiceCommandRoom = lazy(() => import('./components/VoiceCommandRoomV2').then((module) => ({ default: module.VoiceCommandRoom })));

type ElectronWindowStyle = CSSProperties & { WebkitAppRegion: 'drag' | 'no-drag' };
type Surface = 'conversation' | 'operator';

const DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'drag' };
const NO_DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'no-drag' };
const USAGE_GUIDE_STORAGE_KEY = 'ultron-usage-guide-seen-v1';
const MOTION_STORAGE_KEY = 'ultron-motion-enabled-v1';

function loadMotionPreference() {
  return localStorage.getItem(MOTION_STORAGE_KEY) !== '0';
}

function loadInitialSessions(): ChatSession[] {
  const stored = loadSessions();
  return stored.length > 0 ? stored : [createSession(VOICE_MODEL_ID)];
}

function SurfaceLoading({ presence, motionEnabled }: { presence: UltronPresenceState; motionEnabled: boolean }) {
  const loadingPresence = presence === 'idle' ? 'thinking' : presence;
  return (
    <div className="surface-loading" role="status" aria-live="polite">
      <UltronAvatar presence={loadingPresence} size="chat" motionEnabled={motionEnabled} />
      <span><strong>Альтрон выходит на связь</strong><small>Локальный голосовой контур запускается</small></span>
    </div>
  );
}
export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(loadInitialSessions);
  const [activeId, setActiveId] = useState<string>(sessions[0].id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageGuideOpen, setUsageGuideOpen] = useState(() => localStorage.getItem(USAGE_GUIDE_STORAGE_KEY) !== '1');
  const [surface, setSurface] = useState<Surface>('conversation');
  const [contactTurn, setContactTurn] = useState<ContactTurn | null>(null);
  const [presence, setPresence] = useState<UltronPresenceState>('idle');
  const [motionPreference, setMotionPreference] = useState(loadMotionPreference);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const activeSession = sessions.find((session) => session.id === activeId) || sessions[0];

  useEffect(() => { saveSessions(sessions); }, [sessions]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setSystemReducedMotion(event.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (presence !== 'success' && presence !== 'error') return;
    const timeoutId = window.setTimeout(() => setPresence('idle'), presence === 'success' ? 1_400 : 2_400);
    return () => window.clearTimeout(timeoutId);
  }, [presence]);

  const handleNew = () => {
    const session = createSession(VOICE_MODEL_ID);
    setSessions((current) => [session, ...current]);
    setActiveId(session.id);
    setContactTurn(null);
    setPresence('idle');
    setSurface('conversation');
  };

  const handleMessagesChange = (messages: Message[]) => {
    setSessions((current) => current.map((session) => {
      if (session.id !== activeId) return session;
      const firstQuestion = messages.find((message) => message.role === 'user')?.content.trim();
      return {
        ...session,
        model: VOICE_MODEL_ID,
        messages,
        title: firstQuestion ? firstQuestion.slice(0, 48) : 'Новый разговор',
      };
    }));
  };

  const closeUsageGuide = () => {
    localStorage.setItem(USAGE_GUIDE_STORAGE_KEY, '1');
    setUsageGuideOpen(false);
  };

  const openSettingsFromGuide = () => {
    closeUsageGuide();
    setSettingsOpen(true);
  };

  const openSurfaceFromGuide = (nextSurface: Surface) => {
    closeUsageGuide();
    setSurface(nextSurface);
  };

  const queueConversationTurn = (text: string) => {
    setContactTurn({ id: Date.now(), text, mode: 'voice' });
    setSurface('conversation');
  };

  const toggleMotion = () => {
    const next = !motionPreference;
    setMotionPreference(next);
    localStorage.setItem(MOTION_STORAGE_KEY, next ? '1' : '0');
  };

  const motionEnabled = motionPreference && !systemReducedMotion;

  return (
    <div className="h-screen flex bg-bg overflow-hidden sentinel-shell" data-brand="ultron" data-visual-profile="operational">
      <main className="sentinel-main ultron-voice-shell flex-1 flex flex-col min-w-0">
        <header className="sentinel-header ultron-voice-header" style={DRAG_STYLE}>
          <div className="ultron-voice-header__brand" style={NO_DRAG_STYLE}>
            <BrandLockup />
          </div>
          <nav className="surface-switcher" aria-label="Режим Альтрона" style={NO_DRAG_STYLE}>
            <button type="button" aria-pressed={surface === 'conversation'} onClick={() => setSurface('conversation')}>Альтрон</button>
            <button type="button" aria-pressed={surface === 'operator'} onClick={() => setSurface('operator')}>Оператор</button>
          </nav>
          <div className="ultron-voice-header__tools" style={NO_DRAG_STYLE}>
            <div className="ultron-header-presence" data-state={presence}>
              <span aria-hidden="true" />
              <strong>{presence === 'idle' ? 'На связи' : 'Активен'}</strong>
            </div>
            <button type="button" aria-label="Начать новый разговор" onClick={handleNew}>
              <Plus size={15} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Открыть настройки" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Открыть руководство" onClick={() => setUsageGuideOpen(true)}>
              <BookOpen size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="sentinel-workspace flex-1 overflow-hidden">
          <Suspense fallback={<SurfaceLoading presence={presence} motionEnabled={motionEnabled} />}>
            {surface === 'conversation' ? (
              <VoiceConversation
                messages={activeSession.messages}
                onMessagesChange={handleMessagesChange}
                externalTurn={contactTurn}
                onExternalTurnApplied={() => setContactTurn(null)}
                presence={presence}
                onPresenceChange={setPresence}
                motionEnabled={motionEnabled}
              />
            ) : (
              <VoiceCommandRoom
                motionEnabled={motionEnabled}
                motionLocked={systemReducedMotion}
                onMotionChange={toggleMotion}
                onPresenceChange={setPresence}
                onVoiceQuestion={queueConversationTurn}
              />
            )}
          </Suspense>
        </div>
      </main>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UsageGuide
        open={usageGuideOpen}
        onClose={closeUsageGuide}
        onOpenSettings={openSettingsFromGuide}
        onOpenVoice={() => openSurfaceFromGuide('conversation')}
        onOpenOperator={() => openSurfaceFromGuide('operator')}
      />
    </div>
  );
}
