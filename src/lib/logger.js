function write(level, message, context = {}) {
  const timestamp = new Date().toISOString();
  const suffix = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${timestamp}] [${level}] ${message}${suffix}`);
}

export const logger = {
  info(message, context) {
    write("INFO", message, context);
  },
  warn(message, context) {
    write("WARN", message, context);
  },
  error(message, context) {
    write("ERROR", message, context);
  }
};
