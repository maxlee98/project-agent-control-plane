import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "sans-serif"],
        mono: ["DM Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;