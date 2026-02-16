const fs = require('fs');
const path = require('path');

class Logger {
    constructor(moduleName) {
        this.moduleName = moduleName;
        this.logDir = path.resolve('logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    formatMessage(level, message) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] [${this.moduleName}] ${message}`;
    }

    log(level, message, data = null) {
        const formatted = this.formatMessage(level, message);
        // Write directly to stdout to avoid the global console-timestamp patch
        // prepending a second timestamp on top of the one already in `formatted`.
        process.stdout.write(formatted + '\n');
        if (data) {
            process.stdout.write(require('util').inspect(data, { depth: null, colors: true }) + '\n');
        }

        const fileMessage = formatted + (data ? ` ${JSON.stringify(data)}` : '') + '\n';
        fs.appendFileSync(path.join(this.logDir, 'token-generator.log'), fileMessage);
    }

    info(message, data) { this.log('INFO', message, data); }
    warn(message, data) { this.log('WARN', message, data); }
    error(message, data) { this.log('ERROR', message, data); }
    debug(message, data) { if (process.env.DEBUG) this.log('DEBUG', message, data); }
}

module.exports = Logger;
