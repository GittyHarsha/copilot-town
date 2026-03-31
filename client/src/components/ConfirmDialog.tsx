import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'default', onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  const isDanger = variant === 'danger';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="bg-bg-1 border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fg mb-2">{title}</div>
        <div className="text-[12px] text-fg-2 mb-5 leading-relaxed">{message}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-[11px] px-3.5 py-1.5 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg hover:bg-bg-2 border border-border/40 transition-all font-medium"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`text-[11px] px-3.5 py-1.5 rounded-lg border transition-all font-medium ${
              isDanger
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/15'
                : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border-blue-500/15'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
