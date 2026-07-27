/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  safelist: [
    // Status and severity classes are composed from data at runtime, so Tailwind's
    // scanner cannot see them in the source.
    { pattern: /^(bg|text|border|ring)-(slate|emerald|amber|rose|sky|violet)-(50|100|200|300|400|500|600|700|800|900)$/ },
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'Cambria', 'serif'],
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Consolas', 'Menlo', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
        brand: {
          50: '#eef4ff',
          100: '#dae4ff',
          200: '#bccfff',
          300: '#8eaeff',
          400: '#5982ff',
          500: '#3358f5',
          600: '#1f3ae2',
          700: '#1a2eb6',
          800: '#1a2b90',
          900: '#1b2a72',
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        raised: '0 4px 6px -1px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.06)',
        overlay: '0 20px 25px -5px rgb(15 23 42 / 0.15), 0 8px 10px -6px rgb(15 23 42 / 0.1)',
      },
      screens: {
        print: { raw: 'print' },
      },
    },
  },
  plugins: [],
};
