import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#0B0B0F",
        surface: "#111117",
        elevated: "#16161E",
        line: "#23232E",
        muted: "#8A8A9B",
        ink: "#EDEDF2",
        accent: { DEFAULT: "#7C6CFF", soft: "#A99BFF", dim: "#2A2450" },
        ok: "#3DDC97",
        warn: "#F5C542",
        danger: "#FF5C7A",
        info: "#4C7BFF",
      },
      borderRadius: { xl: "0.875rem", "2xl": "1.125rem" },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"] },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.25" } },
      },
      animation: { "fade-up": "fade-up .18s ease-out", blink: "blink 1.1s ease-in-out infinite" },
    },
  },
  plugins: [],
};
export default config;
