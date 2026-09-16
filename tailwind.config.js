import colors from 'tailwindcss/colors'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Same surface palette as Strata Code, Photo and Video so the family
        // feels like one product. Only the accent differs: emerald for Tune,
        // because green reads as diagnostics/health and does not collide with
        // Code's indigo or Photo's gold (master plan section 18).
        studio: {
          bg: '#0c0e14',
          surface: '#121620',
          panel: '#161b26',
          'panel-hi': '#1c2230',
          border: '#232938',
          'border-light': '#323b4e',
          accent: '#10b981',
          'accent-hover': '#059669',
          text: '#f1f5f9',
          muted: '#94a3b8',
          subtle: '#64748b'
        },
        state: {
          ok: colors.emerald,
          warn: colors.amber,
          danger: colors.rose,
          info: colors.sky
        }
      },
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '0.95rem', letterSpacing: '0.01em' }],
        mini: ['0.75rem', { lineHeight: '1.05rem' }]
      },
      borderRadius: {
        control: '0.375rem'
      }
    }
  },
  plugins: []
}
