import { lazy, Suspense, useState, useEffect, type CSSProperties } from 'react';
import { Sidebar } from './components/Sidebar';
import { StatusPanel } from './components/StatusPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { type ChatSession, type Message, loadSessions, saveSessions, createSession, getSelectedModel } from './lib/ai';


const Chat = lazy(() => import('./components/Chat').then((module) => ({ default: module.Chat })));
const VoiceCommandRoom = lazy(() => import('./components/VoiceCommandRoomV2').then((module) => ({ default: module.VoiceCommandRoom })));

type ElectronWindowStyle = CSSProperties & { WebkitAppRegion: 'drag' | 'no-drag' };

const DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'drag' };
const NO_DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'no-drag' };

function loadInitialSessions(): ChatSession[] {
  const stored = loadSessions();
  return stored.length > 0 ? stored : [createSession(getSelectedModel())];
}

function SurfaceLoading() {
  return (
    <div className="h-full grid place-items-center bg-bg text-sm text-text-2" role="status" aria-live="polite">
      Загрузка рабочей поверхности…
    </div>
  );
}
export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(loadInitialSessions);
  const [activeId, setActiveId] = useState<string | null>(sessions[0]?.id || null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [autoSpeak] = useState(() => localStorage.getItem('sentinel-auto-speak') === '1');
  const [surface, setSurface] = useState<'chat' | 'voice'>('voice');

  const activeSession = sessions.find(s => s.id === activeId) || null;

  // Persist sessions
  useEffect(() => { saveSessions(sessions); }, [sessions]);

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

  return (
    <div className="h-screen flex bg-bg overflow-hidden sentinel-shell" data-visual-profile="operational">
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={handleNew}
        onDelete={handleDelete}
        onOpenSettings={() => setSettingsOpen(true)}
        showGuide={showGuide}
        onToggleGuide={toggleGuide}
      />

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Title bar area (draggable for frameless window) */}
        <header className="sentinel-header h-10 flex items-center justify-between px-4 border-b border-border shrink-0"
          style={DRAG_STYLE}>
          <div className="sentinel-header__left flex items-center gap-3" style={NO_DRAG_STYLE}>
            <div className="lg:hidden flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-accent/50" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-text-2">Sentinel</span>
            </div>
            <span className="sentinel-header__title text-[11px] text-text-3">
              {surface === 'voice' ? 'Voice Command Room' : activeSession?.title || 'AI Chat'}
            </span>
            <nav className="surface-switcher" aria-label="Рабочая поверхность">
              <button type="button" aria-pressed={surface === 'voice'} onClick={() => setSurface('voice')}>Команды</button>
              <button type="button" aria-pressed={surface === 'chat'} onClick={() => setSurface('chat')}>Чат</button>
            </nav>
          </div>
          <div className="sentinel-header__status flex items-center gap-2" style={NO_DRAG_STYLE}>
            <div className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
            <span className="text-[10px] text-text-3 uppercase tracking-wider">Connected</span>
          </div>
        </header>

        {/* Chat area */}
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={<SurfaceLoading />}>
              {surface === 'voice' ? <VoiceCommandRoom /> : <Chat
                messages={activeSession?.messages || []}
                onMessagesChange={handleMessagesChange}
                showGuide={showGuide}
                autoSpeak={autoSpeak}
              />}
            </Suspense>
          </div>

          {/* Right panel — status (desktop) */}
          <div className="w-56 border-l border-border hidden xl:block overflow-y-auto">
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
    </div>
  );
}
