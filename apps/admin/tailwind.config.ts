import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#172019',
        oil: '#23732d',
        sand: '#f6f8f2',
        surface: '#f6f8f2',
        'surface-dim': '#e8eee4',
        'surface-bright': '#ffffff',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f1f5ee',
        'surface-container': '#eaf0e7',
        'surface-container-high': '#e4ebe1',
        'surface-container-highest': '#dce5d9',
        'on-surface': '#172019',
        'on-surface-variant': '#667168',
        'green-container': '#183f22',
        'on-green-container': '#dcfce7',
        moss: '#166534',
        line: '#e1e7dd',
        outline: '#9aa79b',
        error: '#b42318',
        'error-container': '#fee4e2',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        xl: '8px',
        '2xl': '8px',
      },
    },
  },
  plugins: [],
};

export default config;
