// ESM, not `module.exports`: package.json sets "type": "module", so a `.js`
// config is loaded as an ES module and CommonJS syntax throws
// "module is not defined in ES module scope" before Tailwind ever runs.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
