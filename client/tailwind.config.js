/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--color-bg)',
          1: 'var(--color-bg-1)',
          2: 'var(--color-bg-2)',
          3: 'var(--color-bg-3)',
        },
        fg: {
          DEFAULT: 'var(--color-fg)',
          1: 'var(--color-fg-1)',
          2: 'var(--color-fg-2)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          1: 'var(--color-border-1)',
        },
        blue: { DEFAULT: '#3b82f6', dim: '#1d4ed8' },
        green: { DEFAULT: '#22c55e', dim: '#16a34a' },
        red: { DEFAULT: '#ef4444', dim: '#dc2626' },
        yellow: { DEFAULT: '#eab308', dim: '#ca8a04' },
        purple: { DEFAULT: '#a855f7' },
        cyan: { DEFAULT: '#06b6d4' },
        pink: { DEFAULT: '#ec4899' },
        orange: { DEFAULT: '#f97316' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
