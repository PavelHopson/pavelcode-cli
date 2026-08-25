import type { CSSProperties } from 'react';
import { Plus, MessageSquare, Settings, Trash2, HelpCircle, BookOpen } from 'lucide-react';
import { type ChatSession } from '../lib/ai';
import { Tooltip } from './Tooltip';
import { BrandLockup } from './BrandMark';

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onOpenUsageGuide: () => void;
  showGuide: boolean;
  onToggleGuide: () => void;
}

type ElectronWindowStyle = CSSProperties & { WebkitAppRegion: 'drag' | 'no-drag' };

const DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'drag' };
const NO_DRAG_STYLE: ElectronWindowStyle = { WebkitAppRegion: 'no-drag' };

export function Sidebar({ sessions, activeId, onSelect, onNew, onDelete, onOpenSettings, onOpenUsageGuide, showGuide, onToggleGuide }: SidebarProps) {
  return (
    <aside className="sentinel-sidebar w-64 border-r border-border flex flex-col shrink-0 hidden lg:flex" style={NO_DRAG_STYLE}>
      {/* Logo */}
      <div className="sidebar-brand h-10 flex items-center gap-3 px-4 border-b border-border" style={DRAG_STYLE}>
        <BrandLockup />
      </div>

      {/* New chat */}
      <div className="p-3">
        <Tooltip text="Начать новый диалог с AI" show={showGuide}>
          <button onClick={onNew}
            className="sidebar-primary w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border text-xs text-text-2 hover:bg-card hover:text-text-1 hover:border-accent/20 transition-all">
            <Plus size={14} />
            Создать диалог
          </button>
        </Tooltip>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        <p className="sidebar-section-label">Диалоги</p>
        {sessions.length === 0 && (
          <p className="sidebar-empty">Здесь появятся ваши локальные рабочие диалоги.</p>
        )}
        {sessions.map((s) => (
          <div key={s.id}
            className={`sidebar-session group ${s.id === activeId ? 'is-active' : ''}`}>
            <button
              type="button"
              className="sidebar-session__select"
              aria-current={s.id === activeId ? 'page' : undefined}
              onClick={() => onSelect(s.id)}
            >
              <MessageSquare size={12} className="shrink-0" />
              <span className="flex-1 truncate">{s.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Удалить диалог «${s.title}»`}
              onClick={() => onDelete(s.id)}
              className="sidebar-session__delete text-text-3 hover:text-red-400 transition-all p-0.5"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Bottom actions */}
      <div className="p-3 border-t border-border space-y-1">
        <Tooltip text="Настройки: API ключ, модель" show={showGuide}>
          <button onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-text-3 hover:bg-card hover:text-text-2 transition-all">
            <Settings size={13} />
            Настройки
          </button>
        </Tooltip>
        <button onClick={onOpenUsageGuide}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-text-3 hover:bg-card hover:text-text-2 transition-all">
          <BookOpen size={13} />
          Как пользоваться
        </button>
        <button onClick={onToggleGuide}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all ${
            showGuide ? 'bg-accent/10 text-accent' : 'text-text-3 hover:bg-card hover:text-text-2'
          }`}>
          <HelpCircle size={13} />
          {showGuide ? 'Скрыть подсказки' : 'Подсказки'}
        </button>
        <p className="sidebar-footnote">Local-first · секреты остаются на устройстве</p>
      </div>
    </aside>
  );
}
