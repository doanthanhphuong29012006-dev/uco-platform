import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#14213d',
        oil: '#2d6a4f',
        sand: '#f7f4ed',
      },
    },
  },
  plugins: [],
};

export default config;
