import { useEffect } from 'react';
import { Cpu, Mic, Server, ShieldCheck, Volume2, X } from 'lucide-react';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-dialog bg-panel border border-border rounded-2xl w-full max-w-md mx-4 overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="settings-title">
            <h2 id="settings-title" className="text-sm font-medium text-text-1">Настройки Eclipse Ultron</h2>
            <p>Локальный голосовой контур</p>
          </div>
          <button type="button" aria-label="Закрыть настройки" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-text-3 hover:bg-card hover:text-text-1 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-xl">
            <Server size={16} className="text-live" />
            <div>
              <p className="text-xs font-medium text-text-1">Ollama · основной локальный контур</p>
              <p className="text-[10px] text-text-3">127.0.0.1:11434 · данные не покидают устройство</p>
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-xl">
            <Cpu size={16} className="text-accent" />
            <div>
              <p className="text-xs font-medium text-text-1">Qwen 3 8B · голосовой профиль</p>
              <p className="text-[10px] text-text-3">Закреплён для быстрой живой беседы без долгого старта 27B</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="px-4 py-3 bg-card border border-border rounded-xl">
              <p className="flex items-center gap-2 text-xs font-medium text-text-1"><Mic size={14} /> Whisper offline</p>
              <p className="mt-1 text-[10px] text-text-3">Распознавание после клика</p>
            </div>
            <div className="px-4 py-3 bg-card border border-border rounded-xl">
              <p className="flex items-center gap-2 text-xs font-medium text-text-1"><Volume2 size={14} /> Windows TTS</p>
              <p className="mt-1 text-[10px] text-text-3">Ответ Альтрона вслух</p>
            </div>
          </div>
          <div className="px-4 py-3 bg-accent/5 border border-accent/20 rounded-xl" role="status">
            <p className="flex items-center gap-2 text-xs font-medium text-accent">
              <ShieldCheck size={14} /> Приватность по умолчанию
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">
              Нет фоновой записи и wake word. Каждая реплика начинается отдельным нажатием.
            </p>
          </div>
          <div className="px-4 py-3 bg-card border border-border rounded-xl">
            <p className="text-[11px] text-text-3 leading-relaxed">
              Локальный runtime и модели:<br/>
              <code className="text-accent text-[10px]">E:\ADMIN_HOPSON_PC\Программы\Eclipse AI Runtime</code>
            </p>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center justify-end">
          <button type="button" onClick={onClose}
            className="px-5 py-2 rounded-lg bg-accent/10 border border-accent/20 text-accent text-xs font-medium hover:bg-accent/15 transition-colors">
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
