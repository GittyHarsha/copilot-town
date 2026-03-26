interface Props {
  theme: 'dark' | 'light';
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: Props) {
  return (
    <button
      onClick={onToggle}
      className="relative w-7 h-7 flex items-center justify-center rounded-md
                 bg-bg-2 border border-border hover:border-border-1
                 text-fg-2 hover:text-fg transition-colors"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      <span className="text-sm leading-none select-none">
        {theme === 'dark' ? '🌙' : '☀️'}
      </span>
    </button>
  );
}
