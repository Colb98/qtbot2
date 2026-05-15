function now() {
  return new Date().toISOString();
}

const logger = {
  info:  (...args) => console.info(`[${now()}][INFO] `, ...args),
  warn:  (...args) => console.warn(`[${now()}][WARN] `, ...args),
  error: (...args) => console.error(`[${now()}][ERROR]`, ...args)
};

module.exports = logger;
