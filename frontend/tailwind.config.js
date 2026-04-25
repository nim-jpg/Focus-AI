/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        theme: {
          work: "#2563eb",
          personal: "#9333ea",
          fitness: "#16a34a",
          finance: "#ca8a04",
          diet: "#ea580c",
          medication: "#dc2626",
          development: "#0d9488",
          household: "#64748b",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
