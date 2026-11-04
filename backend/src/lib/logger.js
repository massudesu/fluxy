function log(message, details) {
  console.log(`[Fluxy] ${message}${details ? ' ' + details : ''}`);
}

function logError(context, error) {
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`[Fluxy] ${context}${code}: ${error?.message || error}`);
  if (error?.stack && !error.code) console.error(error.stack);
}

module.exports = { log, logError };
