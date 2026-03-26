import { useToast, type ToastType } from '../hooks/useToast';

const ICON: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const COLOR: Record<ToastType, string> = {
  success: 'border-green/40 bg-green/10 text-green',
  error: 'border-red/40 bg-red/10 text-red',
  info: 'border-blue/40 bg-blue/10 text-blue',
  warning: 'border-yellow/40 bg-yellow/10 text-yellow',
};

const ICON_BG: Record<ToastType, string> = {
  success: 'bg-green/20 text-green',
  error: 'bg-red/20 text-red',
  info: 'bg-blue/20 text-blue',
  warning: 'bg-yellow/20 text-yellow',
};

export default function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 rounded-lg border
            backdrop-blur-sm shadow-lg shadow-black/30 max-w-[340px] toast-slide-in ${COLOR[t.type]}`}
        >
          <span className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold ${ICON_BG[t.type]}`}>
            {ICON[t.type]}
          </span>
          <span className="text-xs text-fg leading-relaxed flex-1 break-words">{t.message}</span>
          <button
            className="flex-shrink-0 text-fg-2 hover:text-fg text-[10px] p-0.5 -mr-1 -mt-0.5"
            onClick={() => dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
