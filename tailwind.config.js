/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        bitcoin: '#f7931a',
        'bitcoin-dark': '#e8850f'
      }
    }
  },
  plugins: []
}
