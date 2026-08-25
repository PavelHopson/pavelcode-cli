import { lazy, Suspense, useState, useEffect, type CSSProperties } from 'react';
import { BookOpen, Plus, Settings2 } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { StatusPanel } from './components/StatusPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { BrandLockup } from './components/BrandMark';
import { UsageGuide } from './components/UsageGuide';
import { UltronContactDock } from './components/UltronContactDock';
import { UltronAvatar } from './components/UltronAvatar';
import { type ChatSession, type Message, loadSessions, saveSessions, createSession, getSelectedModel } from './lib/ai';
import { type ContactTurn, type UltronPresenceState } from './lib/ultronPresence';


const Chat = lazy(() => import('./components/Chat').then((module) => ({ default: module.Chat })));
const VoiceCommandRoom = lazy(() => import('./components/VoiceCommandRoomV2').then((module) => ({ default: module.VoiceCommandRoom })));

type ElectronWindowStyle = CSSProperties & { WebkitAppRegion: 'drag' | 'no-drag' };

const DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'drag' };
const NO_DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'no-drag' };
const USAGE_GUIDE_STORAGE_KEY = 'ultron-usage-guide-seen-v1';
const MOTION_STORAGE_KEY = 'ultron-motion-enabled-v1';

function loadMotionPreference() {
  return localStorage.getItem(MOTION_STORAGE_KEY) !== '0';
}

function loadInitialSessions(): ChatSession[] {
  const stored = loadSessions();
  return stored.length > 0 ? stored : [createSession(getSelectedModel())];
}

function SurfaceLoading({ presence, motionEnabled }: { presence: UltronPresenceState; motionEnabled: boolean }) {
  const loadingPresence = presence === 'idle' ? 'thinking' : presence;
  return (
    <div className="surface-loading" role="status" aria-live="polite">
      <UltronAvatar presence={loadingPresence} size="chat" motionEnabled={motionEnabled} />
      <span><strong>Альтрон готовит рабочую поверхность</strong><small>Состояние голосовой сессии сохранено</small></span>
    </div>
  );
}
export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(loadInitialSessions);
  const [activeId, setActiveId] = useState<string | null>(sessions[0]?.id || null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageGuideOpen, setUsageGuideOpen] = useState(() => localStorage.getItem(USAGE_GUIDE_STORAGE_KEY) !== '1');
  const [showGuide, setShowGuide] = useState(false);
  const [autoSpeak] = useState(() => localStorage.getItem('sentinel-auto-speak') === '1');
  const [surface, setSurface] = useState<'chat' | 'voice'>('voice');
  const [contactTurn, setContactTurn] = useState<ContactTurn | null>(null);
  const [presence, setPresence] = useState<UltronPresenceState>('idle');
  const [motionPreference, setMotionPreference] = useState(loadMotionPreference);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const activeSession = sessions.find(s => s.id === activeId) || null;

  // Persist sessions
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
    const s = createSession(getSelectedModel());
    setSessions(prev => [s, ...prev]);
    setActiveId(s.id);
  };

  const handleDelete = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeId === id) setActiveId(sessions.find(s => s.id !== id)?.id || null);
  };

  const handleMessagesChange = (msgs: Message[]) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeId) return s;
      // Auto-title from first user message
      const title = s.title === 'Новый чат' && msgs.length > 0
        ? msgs.find(m => m.role === 'user')?.content.slice(0, 40) || 'Новый чат'
        : s.title;
      return { ...s, messages: msgs, title };
    }));
  };

  const handleModelChange = () => {
    // Re-render with new model
    setSessions(prev => [...prev]);
  };

  const toggleGuide = () => {
    const next = !showGuide;
    setShowGuide(next);
    if (!next) localStorage.setItem('sentinel-guide-dismissed', '1');
    else localStorage.removeItem('sentinel-guide-dismissed');
  };

  const closeUsageGuide = () => {
    localStorage.setItem(USAGE_GUIDE_STORAGE_KEY, '1');
    setUsageGuideOpen(false);
  };

  const openSettingsFromGuide = () => {
    closeUsageGuide();
    setSettingsOpen(true);
  };

  const openSurfaceFromGuide = (nextSurface: 'chat' | 'voice') => {
    closeUsageGuide();
    setSurface(nextSurface);
  };

  const openChat = () => {
    if (!activeSession) handleNew();
    setSurface('chat');
  };

  const queueContactTurn = (text: string, mode: ContactTurn['mode']) => {
    if (!activeSession) handleNew();
    setContactTurn({ id: Date.now(), text, mode });
    setSurface('chat');
  };

  const setMotionEnabled = () => {
    const next = !motionPreference;
    setMotionPreference(next);
    localStorage.setItem(MOTION_STORAGE_KEY, next ? '1' : '0');
  };

  const motionEnabled = motionPreference && !systemReducedMotion;

  return (
    <div className="h-screen flex bg-bg overflow-hidden sentinel-shell" data-brand="ultron" data-visual-profile="operational">
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={handleNew}
        onDelete={handleDelete}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenUsageGuide={() => setUsageGuideOpen(true)}
        showGuide={showGuide}
        onToggleGuide={toggleGuide}
      />

      {/* Main */}
      <main className="sentinel-main flex-1 flex flex-col min-w-0">
        {/* Title bar area (draggable for frameless window) */}
        <header className="sentinel-header h-10 flex items-center justify-between px-4 border-b border-border shrink-0"
          style={DRAG_STYLE}>
          <div className="sentinel-header__left flex items-center gap-3" style={NO_DRAG_STYLE}>
            <div className="mobile-header-brand">
              <BrandLockup compact />
            </div>
            <span className="sentinel-header__title text-[11px] text-text-3">
              {surface === 'voice' ? 'Ultron Core · безопасный оператор' : activeSession?.title || 'Новый диалог'}
            </span>
            <nav className="surface-switcher" aria-label="Рабочая поверхность">
              <button type="button" aria-pressed={surface === 'voice'} onClick={() => setSurface('voice')}>Ultron Core</button>
              <button type="button" aria-pressed={surface === 'chat'} onClick={() => setSurface('chat')}>Чат</button>
            </nav>
          </div>
          <div className="sentinel-header__status flex items-center gap-2" style={NO_DRAG_STYLE}>
            <div className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
            <span className="text-[10px] text-text-3 uppercase tracking-wider">Локальный контур</span>
          </div>
          <div className="mobile-header-actions" style={NO_DRAG_STYLE}>
            <button type="button" aria-label="Создать новый диалог" onClick={handleNew}>
              <Plus size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Открыть настройки" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Открыть руководство" onClick={() => setUsageGuideOpen(true)}>
              <BookOpen size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Chat area */}
        <div className="sentinel-workspace flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={<SurfaceLoading presence={presence} motionEnabled={motionEnabled} />}>
              {surface === 'voice' ? <VoiceCommandRoom
                motionEnabled={motionEnabled}
                motionLocked={systemReducedMotion}
                onMotionChange={setMotionEnabled}
                onPresenceChange={setPresence}
              /> : <Chat
                messages={activeSession?.messages || []}
                onMessagesChange={handleMessagesChange}
                showGuide={showGuide}
                autoSpeak={autoSpeak}
                externalTurn={contactTurn}
                onExternalTurnApplied={() => setContactTurn(null)}
                onPresenceChange={setPresence}
                motionEnabled={motionEnabled}
              />}
            </Suspense>
          </div>

          {/* Right panel — status (desktop) */}
          <div className="sentinel-status-rail w-56 border-l border-border hidden 2xl:block overflow-y-auto">
            <StatusPanel showGuide={showGuide} />
          </div>
        </div>
      </main>

      {/* Settings modal */}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onModelChange={handleModelChange}
      />
      <UsageGuide
        open={usageGuideOpen}
        onClose={closeUsageGuide}
        onOpenSettings={openSettingsFromGuide}
        onOpenChat={() => openSurfaceFromGuide('chat')}
        onOpenOperator={() => openSurfaceFromGuide('voice')}
      />
      <UltronContactDock
        surface={surface}
        presence={presence}
        motionEnabled={motionEnabled}
        motionLocked={systemReducedMotion}
        onOpenChat={openChat}
        onOpenOperator={() => setSurface('voice')}
        onDraft={(text) => queueContactTurn(text, 'draft')}
        onVoiceTurn={(text) => queueContactTurn(text, 'voice')}
        onPresenceChange={setPresence}
        onMotionChange={setMotionEnabled}
      />
    </div>
  );
}
