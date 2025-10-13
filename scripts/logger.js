// scripts/logger.js
const chalk = require('chalk');

function now() {
  return new Date().toISOString().replace('T',' ').replace('Z','');
}

function info(msg, ...extra) {
  console.log(chalk.blue(`[INFO ${now()}]`), msg, ...extra);
}

function warn(msg, ...extra) {
  console.log(chalk.yellow(`[WARN ${now()}]`), msg, ...extra);
}

function error(msg, ...extra) {
  console.log(chalk.red(`[ERRO ${now()}]`), msg, ...extra);
}

function debug(msg, ...extra) {
  if (process.env.DEBUG_LOG === '1') {
    console.log(chalk.gray(`[DEBUG ${now()}]`), msg, ...extra);
  }
}

module.exports = { info, warn, error, debug };