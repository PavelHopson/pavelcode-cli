export type UltronCoreState =
  | 'idle'
  | 'listening'
  | 'planning'
  | 'approval'
  | 'executing'
  | 'speaking'
  | 'success'
  | 'blocked';

const CORE_COPY: Record<UltronCoreState, { label: string; detail: string }> = {
  idle: { label: 'Контур готов', detail: 'Ожидаю команду' },
  listening: { label: 'Слушаю', detail: 'Локальное распознавание речи' },
  planning: { label: 'Строю план', detail: 'Изменения ещё не разрешены' },
  approval: { label: 'Жду подтверждение', detail: 'STOP удерживает выполнение' },
  executing: { label: 'Выполняю', detail: 'Один read-only handler' },
  speaking: { label: 'Озвучиваю', detail: 'Локальный голосовой ответ' },
  success: { label: 'Готово', detail: 'Receipt сформирован' },
  blocked: { label: 'Заблокировано', detail: 'Контур остановлен безопасно' },
};

interface UltronCoreProps {
  state: UltronCoreState;
  motionEnabled: boolean;
}

export function UltronCore({ state, motionEnabled }: UltronCoreProps) {
  const copy = CORE_COPY[state];

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="ultron-presence"
      data-motion={motionEnabled ? 'on' : 'off'}
      data-state={state}
      role="status"
    >
      <div className="ultron-core" aria-hidden="true">
        <span className="ultron-core__aura" />
        <span className="ultron-core__ring ultron-core__ring--outer" />
        <span className="ultron-core__ring ultron-core__ring--middle" />
        <span className="ultron-core__ring ultron-core__ring--inner" />
        <span className="ultron-core__scan" />
        <svg className="ultron-core__glyph" viewBox="0 0 160 160">
          <path className="ultron-core__frame" d="M80 18 125 42 142 91 112 135 53 138 19 96 32 43Z" />
          <path className="ultron-core__iris" d="M45 73 66 51h28l21 22-11 35-24 14-24-14Z" />
          <path className="ultron-core__blade" d="M59 78 80 65l21 13-8 24-13 8-13-8Z" />
          <path className="ultron-core__axis" d="M80 8v22M80 130v22M8 80h22M130 80h22" />
          <circle className="ultron-core__eye" cx="80" cy="84" r="10" />
          <circle className="ultron-core__eye-hot" cx="80" cy="84" r="3.5" />
        </svg>
      </div>

      <div className="ultron-presence__copy">
        <span>{copy.label}</span>
        <strong>{copy.detail}</strong>
      </div>
    </div>
  );
}
